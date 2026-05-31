#!/usr/bin/env bash
# pai-anywhere install.sh — bootstrap a private PAI host on Ubuntu/Debian.
# Usage:  curl -fsSL https://raw.githubusercontent.com/gl0bal01/pai-anywhere/v0.2.1/install.sh | bash
# Docs:   docs/QUICKSTART.md
# Threat model: docs/THREAT_MODEL.md
set -eEuo pipefail

# ── pinned constants ──────────────────────────────────────────────────────────
PAI_INSTALLER_URL="https://ourpai.ai/install.sh"
PAI_INSTALLER_SHA256="62814f512f461e684efc88d5ccdd7458fce45021bc55d7ad7f0d6eb97404129e"
BUN_VERSION="1.3.13"
BUN_SHA256_X86_64="79c0771fa8b92c33aae41e15a0e0d307ea99d0e2f00317c71c6c53237a78e25a"
BUN_SHA256_ARM64="70bae41b3908b0a120e1e58c5c8af30e74afae3b8d11b0d3fdd8e787ddfb4b22"

# ── runtime config ────────────────────────────────────────────────────────────
GATEWAY_PORT="${PAI_ANYWHERE_GATEWAY_PORT:-8787}"
SESSION_TTL="${PAI_ANYWHERE_SESSION_TTL_SECONDS:-86400}"
PAI_USER="pai"
PAI_HOME="/home/pai"
APP_DIR="/opt/pai-anywhere"
CFG_DIR="/etc/pai-anywhere"
STATE_DIR="/var/lib/pai-anywhere"
MANIFEST="${CFG_DIR}/install-manifest.jsonl"
VERSION_FILE="${CFG_DIR}/VERSION"
VERSION="0.2.1"
BUN_BIN="${PAI_HOME}/.bun/bin/bun"
BUN_BASE_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"

# ── colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
info()  { printf "${GREEN}[info]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${NC} %s\n" "$*"; }
error() { printf "${RED}[error]${NC} %s\n" "$*" >&2; }
phase() { printf "\n${BOLD}[phase=%s status=start]${NC}\n" "$*"; }
phase_ok() { printf "${BOLD}[phase=%s status=ok]${NC}\n" "$*"; }

# ── audit primitive (intent log — record BEFORE mutation) ─────────────────────
record() {
  # $1=kind  $2=path  $3=action
  printf '{"ts":"%s","kind":"%s","path":"%s","action":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$1" "$2" "$3" >> "${MANIFEST}"
}

# ── helpers ───────────────────────────────────────────────────────────────────
ensure_manifest_dir() {
  if [[ ! -d "${CFG_DIR}" ]]; then
    mkdir -p "${CFG_DIR}"
    chmod 755 "${CFG_DIR}"
  fi
  touch "${MANIFEST}"
}

sha256_verify() {
  local file="$1" expected="$2" label="$3"
  local actual
  actual="$(sha256sum "${file}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]; then
    error "SHA-256 mismatch for ${label}"
    error "  expected: ${expected}"
    error "  actual:   ${actual}"
    return 1
  fi
  info "SHA-256 OK: ${label}"
}

url_safe_b64() {
  # $1 = random byte count; output = url-safe base64 (no padding, no newline)
  openssl rand -base64 "$1" | tr '/+' '_-' | tr -d '=\n'
}

# ── trap: ERR → rollback, EXIT → pairing-code reminder ───────────────────────
_err_trap() {
  error "Install failed at line ${BASH_LINENO[0]}. Running rollback via uninstall.sh …"
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -x "${script_dir}/uninstall.sh" ]]; then
    "${script_dir}/uninstall.sh" --rollback || true
  fi
  exit 1
}

_exit_trap() {
  if [[ -f "${STATE_DIR}/pairing-code.txt" ]]; then
    warn "Reminder: run 'pai-anywhere reset-access' if your terminal scrollback was captured."
  fi
}

trap '_err_trap' ERR
trap '_exit_trap' EXIT

# ═══════════════════════════════════════════════════════════════════════════════
# Phase functions — each idempotent
# ═══════════════════════════════════════════════════════════════════════════════

preflight() {
  phase "preflight"
  # Root check
  if [[ "${EUID}" -ne 0 ]]; then
    error "Must run as root (sudo bash install.sh)"
    exit 1
  fi

  # Ubuntu/Debian only
  if ! grep -qiE '^ID=(ubuntu|debian)' /etc/os-release 2>/dev/null; then
    error "Unsupported OS. Only Ubuntu and Debian are supported in v0.1."
    exit 1
  fi

  # systemd is required for tailscaled, Pulse, and the gateway services.
  if ! command -v systemctl &>/dev/null || [[ ! -d /run/systemd/system ]]; then
    error "systemd is required. Run pai-anywhere on a booted Ubuntu/Debian VPS, not a minimal container."
    exit 1
  fi

  # Refuse if VERSION_FILE missing but APP_DIR already exists (leftover state)
  if [[ ! -f "${VERSION_FILE}" ]] && [[ -d "${APP_DIR}" ]]; then
    error "${APP_DIR} already exists but ${VERSION_FILE} is missing."
    error "This looks like a partial or foreign installation."
    error "Remove ${APP_DIR} manually or run uninstall.sh before reinstalling."
    exit 1
  fi

  # Already installed at same version — idempotent skip
  if [[ -f "${VERSION_FILE}" ]]; then
    local installed_ver
    installed_ver="$(cat "${VERSION_FILE}")"
    if [[ "${installed_ver}" == "${VERSION}" ]]; then
      info "pai-anywhere ${VERSION} already installed. Re-running is safe (idempotent)."
    fi
  fi

  ensure_manifest_dir
  phase_ok "preflight"
}

install_apt_deps() {
  phase "apt-deps"
  local pkgs=(curl ca-certificates gnupg fail2ban ufw git rsync jq unzip)
  local missing=()
  for pkg in "${pkgs[@]}"; do
    if ! dpkg-query -W -f='${Status}' "${pkg}" 2>/dev/null | grep -q "install ok installed"; then
      missing+=("${pkg}")
    fi
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    info "All apt dependencies already installed."
    phase_ok "apt-deps"
    return 0
  fi
  info "Installing: ${missing[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
  phase_ok "apt-deps"
}

install_tailscale_apt() {
  phase "tailscale"
  if command -v tailscale &>/dev/null; then
    info "Tailscale already installed: $(tailscale version | head -1)"
    phase_ok "tailscale"
    return 0
  fi

  info "Installing Tailscale via signed apt repo …"
  # Fetch and verify signing key
  local keyring="/usr/share/keyrings/tailscale-archive-keyring.gpg"
  if [[ ! -f "${keyring}" ]]; then
    record "file" "${keyring}" "create"
    curl -fsSL "https://pkgs.tailscale.com/stable/$(. /etc/os-release; echo "${ID}")/$(. /etc/os-release; echo "${VERSION_CODENAME}").gpg" \
      | gpg --dearmor -o "${keyring}"
    chmod 644 "${keyring}"
  fi

  local sources_file="/etc/apt/sources.list.d/tailscale.list"
  if [[ ! -f "${sources_file}" ]]; then
    record "file" "${sources_file}" "create"
    local os_id os_codename
    os_id="$(. /etc/os-release; echo "${ID}")"
    os_codename="$(. /etc/os-release; echo "${VERSION_CODENAME}")"
    printf 'deb [signed-by=%s] https://pkgs.tailscale.com/stable/%s %s main\n' \
      "${keyring}" "${os_id}" "${os_codename}" > "${sources_file}"
    chmod 644 "${sources_file}"
  fi

  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tailscale
  phase_ok "tailscale"
}

create_pai_user() {
  phase "pai-user"
  if id -u "${PAI_USER}" &>/dev/null; then
    info "User '${PAI_USER}' already exists."
    phase_ok "pai-user"
    return 0
  fi
  record "user" "${PAI_HOME}" "create"
  useradd --system --create-home --home-dir "${PAI_HOME}" \
    --shell /bin/bash --comment "pai-anywhere managed PAI account" "${PAI_USER}"
  passwd -l "${PAI_USER}"
  info "Created locked user '${PAI_USER}' with home ${PAI_HOME}."
  phase_ok "pai-user"
}

install_bun_for_pai() {
  phase "bun"
  if runuser -u "${PAI_USER}" -- test -x "${BUN_BIN}" 2>/dev/null; then
    local installed_bun
    installed_bun="$(runuser -u "${PAI_USER}" -- "${BUN_BIN}" --version 2>/dev/null || true)"
    if [[ "${installed_bun}" == "${BUN_VERSION}" ]]; then
      info "Bun ${BUN_VERSION} already installed for ${PAI_USER}."
      phase_ok "bun"
      return 0
    fi
  fi

  # Select arch-specific tarball + expected hash
  local arch
  arch="$(uname -m)"
  local bun_tarball expected_sha256
  case "${arch}" in
    x86_64)
      bun_tarball="bun-linux-x64.zip"
      expected_sha256="${BUN_SHA256_X86_64}"
      ;;
    aarch64|arm64)
      bun_tarball="bun-linux-aarch64.zip"
      expected_sha256="${BUN_SHA256_ARM64}"
      ;;
    *)
      error "Unsupported architecture: ${arch}"
      exit 1
      ;;
  esac

  local tmpdir
  tmpdir="$(mktemp -d)"
  chown "${PAI_USER}:${PAI_USER}" "${tmpdir}"
  chmod 755 "${tmpdir}"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmpdir}'" RETURN

  info "Downloading Bun ${BUN_VERSION} (${arch}) …"
  curl -fsSL "${BUN_BASE_URL}/${bun_tarball}" -o "${tmpdir}/${bun_tarball}"
  sha256_verify "${tmpdir}/${bun_tarball}" "${expected_sha256}" "bun-${arch}-${BUN_VERSION}"
  chown "${PAI_USER}:${PAI_USER}" "${tmpdir}/${bun_tarball}"

  record "file" "${PAI_HOME}/.bun" "create"
  runuser -u "${PAI_USER}" -- bash -c "
    set -euo pipefail
    cd '${tmpdir}'
    unzip -q '${bun_tarball}'
    mkdir -p '${PAI_HOME}/.bun/bin'
    cp bun-linux-*/bun '${PAI_HOME}/.bun/bin/bun'
    chmod 755 '${PAI_HOME}/.bun/bin/bun'
  "
  info "Bun ${BUN_VERSION} installed for ${PAI_USER}."
  phase_ok "bun"
}

fetch_and_verify_pai() {
  phase "fetch-pai"
  local tmpfile
  tmpfile="$(mktemp /tmp/pai-installer-XXXXXX.sh)"
  # shellcheck disable=SC2064
  trap "rm -f '${tmpfile}'" RETURN

  info "Fetching upstream PAI installer …"
  curl -fsSL "${PAI_INSTALLER_URL}" -o "${tmpfile}"
  sha256_verify "${tmpfile}" "${PAI_INSTALLER_SHA256}" "PAI installer"

  # Stage verified installer for run_pai_as_pai
  mkdir -p "${STATE_DIR}/tmp"
  chmod 711 "${STATE_DIR}/tmp"
  cp "${tmpfile}" "${STATE_DIR}/tmp/pai-installer.sh"
  chmod 500 "${STATE_DIR}/tmp/pai-installer.sh"
  chown "${PAI_USER}:${PAI_USER}" "${STATE_DIR}/tmp/pai-installer.sh"
  phase_ok "fetch-pai"
}

run_pai_as_pai() {
  phase "pai-bootstrap"
  local pai_claude_dir="${PAI_HOME}/.claude"

  # Refuse to run over an existing managed profile — no silent reinstall
  if [[ -d "${pai_claude_dir}" ]]; then
    info "Managed profile ${pai_claude_dir} already exists; skipping PAI bootstrap."
    phase_ok "pai-bootstrap"
    return 0
  fi

  local installer="${STATE_DIR}/tmp/pai-installer.sh"
  if [[ ! -f "${installer}" ]]; then
    error "Verified installer not found at ${installer}; run fetch_and_verify_pai first."
    exit 1
  fi

  info "Running official PAI installer as '${PAI_USER}' …"
  record "file" "${pai_claude_dir}" "create"
  # PAI_TEST_AUTOMATED=1 makes the bundled CLI wizard skip readline prompts.
  # Upstream installer ends with `exec zsh -i -c 'pai' < /dev/tty` which fails
  # in non-tty contexts (the upstream `[ -r /dev/tty ]` test is unreliable —
  # access(2) reports the device readable even when no controlling terminal
  # exists). We tolerate that failure and verify success by the presence of
  # the canonical PAI marker file, since install body completed before exec.
  local installer_exit=0
  setsid runuser -u "${PAI_USER}" -- env \
    HOME="${PAI_HOME}" \
    PATH="${PAI_HOME}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    PAI_TEST_AUTOMATED=1 \
    bash "${installer}" </dev/null || installer_exit=$?
  rm -f "${installer}"

  # Verify by canonical marker rather than installer exit code
  if [[ ! -f "${pai_claude_dir}/CLAUDE.md" ]]; then
    error "PAI installer reported exit ${installer_exit} and ${pai_claude_dir}/CLAUDE.md is missing — genuine failure."
    exit 1
  fi
  if [[ "${installer_exit}" -ne 0 ]]; then
    warn "PAI installer trailing exec returned ${installer_exit} (expected; upstream /dev/tty quirk)."
    warn "Profile body installed successfully — verified by ${pai_claude_dir}/CLAUDE.md presence."
  fi
  phase_ok "pai-bootstrap"
}

pai_post_bootstrap_fixes() {
  phase "pai-fixes"
  # Upstream PAI v5.0.0 ships 3 self-referencing symlinks
  # (e.g. .cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc → itself).
  # These cause Pulse's file watcher to crash with ELOOP. Remove them.
  local broken_count=0
  while IFS= read -r -d '' link; do
    local target
    target="$(readlink "${link}" 2>/dev/null || echo '')"
    if [[ "${link}" == "${target}" ]] || ! [[ -e "${link}" ]]; then
      rm -f "${link}"
      record "file" "${link}" "remove"
      broken_count=$((broken_count + 1))
    fi
  done < <(find "${PAI_HOME}/.claude" -maxdepth 10 -type l -print0 2>/dev/null)
  if [[ "${broken_count}" -gt 0 ]]; then
    info "Removed ${broken_count} self-referencing symlink(s) (upstream PAI v5.0.0 packaging quirk)."
  fi

  # Upstream PAI installer prints "Claude Code not found — will install during
  # setup" but never actually runs the install. Install it for the pai user.
  if ! runuser -u "${PAI_USER}" -- bash -lc 'command -v claude' &>/dev/null; then
    info "Installing Claude Code CLI for ${PAI_USER} (upstream installer skipped this) …"
    runuser -u "${PAI_USER}" -- bash -lc \
      "export PATH=${PAI_HOME}/.bun/bin:\$PATH; bun add -g @anthropic-ai/claude-code"
    record "file" "${PAI_HOME}/.bun/bin/claude" "create"
  else
    info "Claude Code CLI already installed for ${PAI_USER}."
  fi

  # Upstream PAI v5.0.0 has multiple case-mismatch bugs on Linux:
  #   - observability.ts hard-codes "PAI/Pulse/Observability/out" (dir is "PULSE")
  #   - .zshrc alias hard-codes "PAI/Tools/pai.ts"             (dir is "TOOLS")
  # macOS HFS+/APFS is case-insensitive so upstream never noticed.
  # Linux is case-sensitive: add lower/CamelCase → ALL_CAPS symlinks.
  local pair upper lower
  for pair in "PULSE:Pulse" "TOOLS:Tools" "MEMORY:Memory" "ALGORITHM:Algorithm" "DOCUMENTATION:Documentation" "TEMPLATES:Templates"; do
    upper="${pair%:*}"
    lower="${pair#*:}"
    if [[ -d "${PAI_HOME}/.claude/PAI/${upper}" ]] && [[ ! -e "${PAI_HOME}/.claude/PAI/${lower}" ]]; then
      runuser -u "${PAI_USER}" -- ln -s "${upper}" "${PAI_HOME}/.claude/PAI/${lower}"
      record "file" "${PAI_HOME}/.claude/PAI/${lower}" "create"
      info "Added PAI/${lower} → ${upper} case-fix symlink."
    fi
  done

  phase_ok "pai-fixes"
}

install_gateway_app() {
  phase "gateway-app"
  local src_dir
  src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if [[ "${src_dir}" == "${APP_DIR}" ]]; then
    info "Already running from ${APP_DIR}; skipping rsync."
    phase_ok "gateway-app"
    return 0
  fi

  record "file" "${APP_DIR}" "create"
  mkdir -p "${APP_DIR}"
  rsync -a --delete --no-owner --no-group \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.omc' \
    --exclude='docs' \
    --exclude='tests' \
    --exclude='scripts' \
    "${src_dir}/" "${APP_DIR}/"

  # Symlink for convenient invocation, then chown the bundle before bun install
  mkdir -p "${APP_DIR}/bin"
  ln -sf "${APP_DIR}/src/cli.ts" "${APP_DIR}/bin/pai-anywhere" 2>/dev/null || true
  chown -R "${PAI_USER}:${PAI_USER}" "${APP_DIR}"

  # Install TS deps as pai user (after chown so node_modules can be created)
  runuser -u "${PAI_USER}" -- bash -c "
    export HOME='${PAI_HOME}'
    export PATH='${PAI_HOME}/.bun/bin:\$PATH'
    cd '${APP_DIR}'
    bun install --frozen-lockfile --production 2>/dev/null || bun install --production
  "
  info "Gateway app installed to ${APP_DIR}."
  phase_ok "gateway-app"
}

generate_secrets() {
  phase "secrets"
  mkdir -p "${STATE_DIR}"
  chmod 700 "${STATE_DIR}"
  chown "${PAI_USER}:${PAI_USER}" "${STATE_DIR}"

  local pairing_file="${STATE_DIR}/pairing-code.txt"
  local secrets_file="${STATE_DIR}/gateway-secrets.json"

  if [[ ! -f "${pairing_file}" ]]; then
    record "file" "${pairing_file}" "create"
    # 20-char URL-safe base64 from 15 random bytes → 120 bits entropy
    url_safe_b64 15 > "${pairing_file}"
    chmod 0600 "${pairing_file}"
    chown "${PAI_USER}:${PAI_USER}" "${pairing_file}"
    info "Pairing code generated."
  else
    info "Pairing code already exists."
  fi

  if [[ ! -f "${secrets_file}" ]]; then
    record "file" "${secrets_file}" "create"
    # 256 bits of entropy, base64url-encoded. The gateway reads this JSON file.
    local session_secret
    session_secret="$(url_safe_b64 32)"
    jq -n --arg ts "$(date -u +%FT%TZ)" --arg s "${session_secret}" \
      '{schema:"pai-anywhere.gateway-secrets.v1",createdAt:$ts,sessionSecret:$s}' \
      > "${secrets_file}"
    chmod 0600 "${secrets_file}"
    chown "${PAI_USER}:${PAI_USER}" "${secrets_file}"
    info "Gateway session secret generated."
  else
    info "Gateway session secret already exists."
  fi

  # Write gateway.env for systemd EnvironmentFile (pairing code injected here).
  # Session secrets live in ${secrets_file}; do not duplicate them in env.
  local env_file="${CFG_DIR}/gateway.env"
  record "file" "${env_file}" "create"
  local pairing
  pairing="$(cat "${pairing_file}")"
  printf 'PAI_ANYWHERE_PAIRING_CODE=%s\n' "${pairing}" > "${env_file}"
  chmod 0600 "${env_file}"
  chown "root:${PAI_USER}" "${env_file}"
  phase_ok "secrets"
}

write_systemd_units() {
  phase "systemd"
  local svc_gateway="/etc/systemd/system/pai-anywhere.service"
  local svc_pulse="/etc/systemd/system/pai-pulse.service"

  record "file" "${svc_gateway}" "create"
  cat > "${svc_gateway}" <<GATEWAY_UNIT
[Unit]
Description=pai-anywhere private loopback gateway
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=${PAI_USER}
Group=${PAI_USER}
Environment=PAI_ANYWHERE_STATE_DIR=${STATE_DIR}
Environment=PAI_ANYWHERE_CONFIG_DIR=${CFG_DIR}
Environment=PAI_ANYWHERE_MANIFEST=${MANIFEST}
Environment=PAI_ANYWHERE_GATEWAY_HOST=127.0.0.1
Environment=PAI_ANYWHERE_GATEWAY_PORT=${GATEWAY_PORT}
Environment=PAI_ANYWHERE_COOKIE_SECURE=1
Environment=PAI_ANYWHERE_SESSION_TTL_SECONDS=${SESSION_TTL}
Environment=PAI_ANYWHERE_PULSE_ORIGIN=http://127.0.0.1:31337
EnvironmentFile=${CFG_DIR}/gateway.env
WorkingDirectory=${APP_DIR}
ExecStart=${BUN_BIN} run ${APP_DIR}/src/cli.ts gateway --port ${GATEWAY_PORT}
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${STATE_DIR}
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
GATEWAY_UNIT

  record "file" "${svc_pulse}" "create"
  cat > "${svc_pulse}" <<PULSE_UNIT
[Unit]
Description=PAI Pulse loopback service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${PAI_USER}
Group=${PAI_USER}
WorkingDirectory=${PAI_HOME}/.claude/PAI/PULSE
Environment=HOME=${PAI_HOME}
Environment=PULSE_PORT=31337
Environment=PAI_PULSE_BIND_ALL=0
Environment=PAI_ANYWHERE_MANAGED=1
Environment=TMPDIR=/tmp
Environment=BUN_INSTALL_CACHE_DIR=${PAI_HOME}/.bun/install/cache
ExecStart=${BUN_BIN} run pulse.ts
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${PAI_HOME}/.claude ${PAI_HOME}/.bun ${STATE_DIR}
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
PULSE_UNIT

  systemctl daemon-reload
  systemctl enable --now pai-pulse.service
  systemctl enable --now pai-anywhere.service
  info "Systemd units installed and started."
  phase_ok "systemd"
}

tailscale_up_if_needed() {
  phase "tailscale-up"
  local backend_state
  backend_state="$(tailscale status --json 2>/dev/null | jq -r '.BackendState' 2>/dev/null || echo "Stopped")"
  if [[ "${backend_state}" == "Running" ]]; then
    info "Tailscale already running."
    phase_ok "tailscale-up"
    return 0
  fi
  info "Starting Tailscale …"
  systemctl enable --now tailscaled
  # Interactive: print auth link and wait for login
  tailscale up --advertise-exit-node=false 2>&1 | tee /tmp/tailscale-up.log || true
  # Wait up to 120 seconds for Running state
  local i=0
  while [[ "${i}" -lt 24 ]]; do
    backend_state="$(tailscale status --json 2>/dev/null | jq -r '.BackendState' 2>/dev/null || echo "Stopped")"
    if [[ "${backend_state}" == "Running" ]]; then
      break
    fi
    sleep 5
    i=$((i + 1))
  done
  if [[ "${backend_state}" != "Running" ]]; then
    error "Tailscale did not reach Running state within 120 seconds."
    error "Open the auth link above in your browser, then rerun install.sh."
    exit 1
  fi
  phase_ok "tailscale-up"
}

tailscale_serve_private() {
  phase "tailscale-serve"

  # Safety: refuse if Funnel is enabled on this host
  local serve_status
  serve_status="$(tailscale serve status 2>/dev/null || echo "")"
  if echo "${serve_status}" | grep -qi "funnel"; then
    error "Tailscale Funnel is detected on this host. pai-anywhere never enables Funnel."
    error "Disable Funnel manually then rerun install.sh."
    exit 1
  fi

  # Check if Serve is already configured for our port
  if echo "${serve_status}" | grep -q "127.0.0.1:${GATEWAY_PORT}"; then
    info "Tailscale Serve already configured for port ${GATEWAY_PORT}."
    phase_ok "tailscale-serve"
    return 0
  fi

  # Check if there's unmanaged Serve config (refuse to overwrite)
  if echo "${serve_status}" | grep -qv "^$" && ! echo "${serve_status}" | grep -q "pai-anywhere"; then
    if echo "${serve_status}" | grep -qE "https?://"; then
      error "Existing unmanaged Tailscale Serve config detected."
      error "pai-anywhere will not overwrite it. Remove it manually with 'tailscale serve reset'."
      exit 1
    fi
  fi

  info "Configuring Tailscale Serve (private HTTPS → 127.0.0.1:${GATEWAY_PORT}) …"
  tailscale serve --bg "http://127.0.0.1:${GATEWAY_PORT}"
  phase_ok "tailscale-serve"
}

verify_install() {
  phase "verify"
  local pai_bin="${APP_DIR}/bin/pai-anywhere"
  if [[ ! -x "${pai_bin}" ]] && [[ ! -L "${pai_bin}" ]]; then
    error "Gateway binary not found at ${pai_bin}"
    exit 1
  fi
  info "Running doctor …"
  runuser -u "${PAI_USER}" -- env HOME="${PAI_HOME}" \
    PATH="${PAI_HOME}/.bun/bin:${PATH}" \
    PAI_ANYWHERE_STATE_DIR="${STATE_DIR}" \
    PAI_ANYWHERE_CONFIG_DIR="${CFG_DIR}" \
    "${BUN_BIN}" run "${APP_DIR}/src/cli.ts" doctor || {
      error "Doctor reported failures. Installation incomplete."
      exit 1
    }
  phase_ok "verify"
}

write_version_file() {
  record "file" "${VERSION_FILE}" "create"
  printf '%s\n' "${VERSION}" > "${VERSION_FILE}"
  chmod 644 "${VERSION_FILE}"
}

print_done() {
  # Pairing code is NEVER written to stdout raw.
  # It is read from the 0600 file and shown only after a clear-screen + pause.
  local tailnet_json dns_name tailnet_url
  tailnet_json="$(tailscale status --json 2>/dev/null || echo '{}')"
  dns_name="$(printf '%s' "${tailnet_json}" | jq -r '.Self.DNSName // empty' 2>/dev/null || true)"
  dns_name="${dns_name%.}"   # strip trailing dot
  tailnet_url="${dns_name:-<your-tailnet-hostname>}"
  local pairing
  pairing="$(cat "${STATE_DIR}/pairing-code.txt")"

  clear
  printf '%b\n' "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  printf '%b\n' "${GREEN}  pai-anywhere ${VERSION} installed successfully!${NC}"
  printf '%b\n' "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  printf '\n'
  printf '  Private URL:   https://%s\n' "${tailnet_url}"
  printf '  Pairing code:  %s\n' "${pairing}"
  printf '\n'
  printf '  Open the URL from any device on your Tailnet,\n'
  printf '  then enter the pairing code when prompted.\n'
  printf '\n'
  printf '%b\n' "${YELLOW}  ⚠  If your terminal scrollback was captured (e.g. piped to tee),${NC}"
  printf '%b\n' "${YELLOW}     run: pai-anywhere reset-access${NC}"
  printf '%b\n' "${YELLOW}     to rotate the pairing code and invalidate old sessions.${NC}"
  printf '\n'
  printf '%b\n' "${BOLD}─── Use pai from Desktop/Laptop ─────────────────${NC}"
  printf '\n'
  printf '  Add this alias to ~/.zshrc (or ~/.bashrc) on each client device:\n'
  printf '\n'
  printf '%b\n' "${GREEN}    alias pai='ssh ${SUDO_USER:-${USER}}@${tailnet_url} -t \"sudo -iu pai -- pai\"'${NC}"
  printf '\n'
  printf '  Then type %bpai%b from anywhere — same memory, same auth, same VPS.\n' "${BOLD}" "${NC}"
  printf '  Tailscale handles the network. SSH key handles the auth.\n'
  printf '\n'
  printf '%b\n' "${BOLD}─── Pulse dashboard (mobile / browser) ──────────${NC}"
  printf '\n'
  printf '  Open the URL above from any tailnet device, enter pairing code.\n'
  printf '\n'
  if [[ -t 0 ]]; then
    read -r -p "  Press Enter once you have recorded the pairing code: "
    printf '\n'
  else
    printf '%b\n' "${YELLOW}  (non-interactive run — pairing code retained at /var/lib/pai-anywhere/pairing-code.txt)${NC}"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# main
# ═══════════════════════════════════════════════════════════════════════════════
main() {
  preflight
  install_apt_deps
  install_tailscale_apt
  create_pai_user
  install_bun_for_pai
  fetch_and_verify_pai
  run_pai_as_pai
  pai_post_bootstrap_fixes
  install_gateway_app
  generate_secrets
  write_systemd_units
  tailscale_up_if_needed
  tailscale_serve_private
  verify_install
  write_version_file
  print_done
}

main "$@"
