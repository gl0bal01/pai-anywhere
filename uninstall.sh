#!/usr/bin/env bash
# pai-anywhere uninstall.sh — reverse only manifest-recorded mutations.
# Usage:  sudo bash uninstall.sh
#         sudo bash uninstall.sh --rollback      (called by install.sh ERR trap)
#         sudo bash uninstall.sh --purge-data    (ALSO delete /home/pai incl. PAI data)
# Docs:   docs/QUICKSTART.md
set -euo pipefail

# ── config (must match install.sh) ────────────────────────────────────────────
PAI_USER="pai"
PAI_HOME="/home/pai"
APP_DIR="/opt/pai-anywhere"
CFG_DIR="/etc/pai-anywhere"
STATE_DIR="/var/lib/pai-anywhere"
MANIFEST="${CFG_DIR}/install-manifest.jsonl"

# Gateway port — needed to remove only OUR Tailscale Serve route, never others.
# Best-effort: env override, else the value baked into the installed unit, else default.
GATEWAY_PORT="${PAI_ANYWHERE_GATEWAY_PORT:-8787}"
if [[ -f /etc/systemd/system/pai-anywhere.service ]]; then
  _port="$(grep -oE 'PAI_ANYWHERE_GATEWAY_PORT=[0-9]+' /etc/systemd/system/pai-anywhere.service 2>/dev/null \
            | grep -oE '[0-9]+' | head -1 || true)"
  [[ -n "${_port:-}" ]] && GATEWAY_PORT="${_port}"
fi

# Path prefix allowlist — uninstall may only act on these owned paths
ALLOWED_PREFIXES=(
  "${APP_DIR}"
  "${CFG_DIR}"
  "${STATE_DIR}"
  "${PAI_HOME}"
  "/etc/systemd/system/pai-anywhere.service"
  "/etc/systemd/system/pai-pulse.service"
  "/usr/local/bin/pai-anywhere"
  "/usr/share/keyrings/tailscale-archive-keyring.gpg"
  "/etc/apt/sources.list.d/tailscale.list"
)

# ── colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()   { printf "${GREEN}[info]${NC} %s\n" "$*"; }
warn()   { printf "${YELLOW}[warn]${NC} %s\n" "$*"; }
error()  { printf "${RED}[error]${NC} %s\n" "$*" >&2; }

# ── helpers ───────────────────────────────────────────────────────────────────
is_allowed_path() {
  local target="$1"
  local prefix
  for prefix in "${ALLOWED_PREFIXES[@]}"; do
    # Match the prefix exactly, or as a path-segment boundary (prefix + "/").
    # A bare "${prefix}"* glob would also match siblings like "/home/pai-evil"
    # for the "/home/pai" prefix; the "/" boundary prevents that.
    case "${target}" in
      "${prefix}"|"${prefix}/"*) return 0 ;;
    esac
  done
  return 1
}

safe_remove() {
  # $1 = path to remove
  local target="$1"

  if ! is_allowed_path "${target}"; then
    error "ABORT: path '${target}' is outside pai-anywhere-owned prefixes."
    error "Manual review required. Aborting uninstall."
    exit 1
  fi

  # ENOENT → already clean
  if [[ ! -e "${target}" ]] && [[ ! -L "${target}" ]]; then
    info "Already removed (ENOENT): ${target}"
    return 0
  fi

  # Manifest-recorded symlinks are safe to unlink; rm removes the link itself.
  if [[ -L "${target}" ]]; then
    rm -f "${target}"
    info "Removed symlink: ${target}"
    return 0
  fi

  # Permission check
  if [[ ! -r "${target}" ]]; then
    error "ABORT: cannot read '${target}' (EACCES). Manual review required."
    exit 1
  fi

  # Defense in depth: resolve the real path (in case a PARENT component is a
  # symlink) and re-verify it is still inside an owned prefix before any rm -rf.
  # rm -rf does not follow symlinks itself, but a symlinked ancestor could move
  # the deletion target outside the allowlist.
  local resolved
  resolved="$(realpath -m "${target}" 2>/dev/null || echo "${target}")"
  if [[ "${resolved}" != "${target}" ]] && ! is_allowed_path "${resolved}"; then
    error "ABORT: '${target}' resolves to '${resolved}', outside owned prefixes."
    error "Refusing to delete. Manual review required."
    exit 1
  fi

  # /opt/pai-anywhere is an installer-owned app bundle. Its copied files are not
  # individually manifest-recorded, so remove the bundle as one owned unit.
  if [[ "${target}" == "${APP_DIR}" ]]; then
    rm -rf "${target}"
    info "Removed app bundle: ${target}"
    return 0
  fi

  # For other directories: check for unowned content before removal.
  if [[ -d "${target}" ]]; then
    # Read manifest-recorded paths to know what we own
    local manifest_paths
    manifest_paths="$(jq -r '.path' "${MANIFEST}" 2>/dev/null | sort -u || true)"
    # List immediate children not in manifest
    local child
    while IFS= read -r -d '' child; do
      # -x: exact whole-line match. A substring match (-qF alone) would count
      # "/etc/pai-anywhere/VER" as owned because the manifest lists
      # ".../VERSION" — and an all-children-prefix-collision would then
      # rm -rf the directory including unowned content.
      if ! echo "${manifest_paths}" | grep -qFx "${child}"; then
        # Child not in manifest — this directory contains unowned content
        warn "Directory '${target}' contains unowned content: ${child}"
        warn "Removing only the pai-anywhere-owned children; directory structure preserved."
        return 0
      fi
    done < <(find "${target}" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
  fi

  rm -rf "${target}"
  info "Removed: ${target}"
}

disable_service() {
  local svc="$1"
  if systemctl is-enabled "${svc}" &>/dev/null; then
    systemctl disable --now "${svc}" 2>/dev/null || true
    info "Disabled and stopped: ${svc}"
  fi
  local unit_file="/etc/systemd/system/${svc}"
  safe_remove "${unit_file}"
}

remove_user() {
  # $1 = purge_data (0|1). Default uninstall removes only the user ACCOUNT and
  # PRESERVES ${PAI_HOME} (incl. ${PAI_HOME}/.claude: PAI memory, Claude OAuth/
  # session state). The home is deleted ONLY with --purge-data + typed consent.
  local purge_data="$1"

  id -u "${PAI_USER}" &>/dev/null || return 0

  # Only act if the home is actually owned by the managed user.
  local home_owner
  home_owner="$(stat -c '%U' "${PAI_HOME}" 2>/dev/null || echo "unknown")"
  if [[ "${home_owner}" != "${PAI_USER}" ]]; then
    warn "Home ${PAI_HOME} is owned by '${home_owner}', not '${PAI_USER}'."
    warn "Skipping user/home deletion. Manual review required."
    return 0
  fi

  if [[ "${purge_data}" -eq 1 ]]; then
    if [[ ! -t 0 ]]; then
      warn "--purge-data requires an interactive terminal for confirmation."
      warn "Removing account only; PRESERVING ${PAI_HOME}. Re-run interactively to purge data."
      userdel "${PAI_USER}" 2>/dev/null || warn "userdel failed (running processes?). Skipping."
      return 0
    fi
    warn "--purge-data will PERMANENTLY DELETE ${PAI_HOME}, including:"
    warn "  ${PAI_HOME}/.claude  (PAI memory, Claude OAuth/session state, operator config)"
    printf '%bType the user name "%s" to confirm permanent deletion: %b' "${YELLOW}" "${PAI_USER}" "${NC}"
    local confirm=""
    read -r confirm || true
    if [[ "${confirm}" != "${PAI_USER}" ]]; then
      warn "Confirmation mismatch — preserving ${PAI_HOME}. Removing account only."
      userdel "${PAI_USER}" 2>/dev/null || warn "userdel failed (running processes?). Skipping."
      return 0
    fi
    userdel -r "${PAI_USER}" 2>/dev/null || {
      warn "userdel -r failed (user may have running processes). Skipping."
      return 0
    }
    info "Removed user '${PAI_USER}' and home ${PAI_HOME} (--purge-data)."
  else
    # Account only — keep the data. This matches the user-facing note below.
    userdel "${PAI_USER}" 2>/dev/null || {
      warn "userdel failed (user may have running processes). Skipping."
      return 0
    }
    info "Removed user account '${PAI_USER}'. PRESERVED ${PAI_HOME} and ${PAI_HOME}/.claude."
  fi
}

remove_tailscale_serve() {
  # Remove ONLY pai-anywhere's own Serve route. Never run the global
  # `tailscale serve reset` if the host has OTHER loopback routes — that would
  # wipe unrelated services the operator configured.
  command -v tailscale &>/dev/null || return 0

  local serve_status
  serve_status="$(tailscale serve status 2>/dev/null || echo "")"
  # Our route present?
  echo "${serve_status}" | grep -q "127.0.0.1:${GATEWAY_PORT}" || return 0

  # Any OTHER loopback backend on a different port?
  local other
  other="$(echo "${serve_status}" | grep -oE '127\.0\.0\.1:[0-9]+' \
            | grep -vx "127.0.0.1:${GATEWAY_PORT}" | sort -u || true)"
  if [[ -n "${other}" ]]; then
    warn "Tailscale Serve has other loopback routes: $(echo "${other}" | tr '\n' ' ')"
    warn "Refusing global 'tailscale serve reset' to avoid wiping unrelated services."
    warn "Remove only the pai-anywhere route manually, e.g.:"
    warn "  tailscale serve --https=443 off    # the handler fronting 127.0.0.1:${GATEWAY_PORT}"
    return 0
  fi

  # Our route is the only loopback backend — safe to clear.
  tailscale serve reset 2>/dev/null || true
  info "Tailscale Serve config cleared (only the pai-anywhere route was present)."
}

# ═══════════════════════════════════════════════════════════════════════════════
# main
# ═══════════════════════════════════════════════════════════════════════════════
main() {
  if [[ "${EUID}" -ne 0 ]]; then
    error "Must run as root (sudo bash uninstall.sh)"
    exit 1
  fi

  local rollback_mode=0
  local purge_data=0
  local arg
  for arg in "$@"; do
    case "${arg}" in
      --rollback)   rollback_mode=1 ;;
      --purge-data) purge_data=1 ;;
      *) warn "Unknown argument '${arg}' — ignoring." ;;
    esac
  done
  [[ "${rollback_mode}" -eq 1 ]] && warn "Rollback mode: reversing partial install state."
  [[ "${purge_data}" -eq 1 ]] && warn "Purge-data mode: ${PAI_HOME} will be deleted after confirmation."

  if [[ ! -f "${MANIFEST}" ]]; then
    if [[ "${rollback_mode}" -eq 1 ]]; then
      info "No manifest found — nothing to roll back."
      exit 0
    fi
    error "Manifest not found at ${MANIFEST}. Nothing to uninstall."
    exit 1
  fi

  # Validate every line is parseable JSON before acting.
  local line_num=0 line
  while IFS= read -r line; do
    line_num=$((line_num + 1))
    [[ -z "${line}" ]] && continue
    if ! printf '%s' "${line}" | jq -e . &>/dev/null; then
      error "Corrupt manifest at line ${line_num}: ${line}"
      error "Manual review required. Aborting."
      exit 1
    fi
  done < "${MANIFEST}"

  info "Processing manifest: ${MANIFEST}"

  # Process entries in reverse order (LIFO). Each JSONL record is parsed
  # individually with jq, so embedded tabs/newlines in a field can never split
  # or misalign columns the way a shared @tsv + IFS split could.
  local manifest_lines=()
  mapfile -t manifest_lines < "${MANIFEST}"

  local needs_daemon_reload=0
  local idx kind path
  for (( idx=${#manifest_lines[@]} - 1; idx >= 0; idx-- )); do
    line="${manifest_lines[idx]}"
    [[ -z "${line}" ]] && continue
    kind="$(printf '%s' "${line}" | jq -r '.kind // empty' 2>/dev/null || echo "")"
    path="$(printf '%s' "${line}" | jq -r '.path // empty' 2>/dev/null || echo "")"
    [[ -z "${path}" ]] && continue
    case "${kind}" in
      file|directory)
        # Compat: manifests written by install.sh <= v0.2.3 recorded systemd
        # units as kind=file. Route them through disable_service so the
        # service is stopped/disabled, not just its unit file deleted.
        case "${path}" in
          /etc/systemd/system/*.service)
            disable_service "$(basename "${path}")"
            needs_daemon_reload=1
            ;;
          *)
            safe_remove "${path}"
            ;;
        esac
        ;;
      systemd-service)
        disable_service "$(basename "${path}")"
        needs_daemon_reload=1
        ;;
      user)
        # In rollback mode (install.sh ERR trap) leave the pai user/home in
        # place — it may pre-date this install attempt or hold data the operator
        # wants to inspect. Full uninstall removes the ACCOUNT but preserves the
        # home unless --purge-data was given.
        if [[ "${rollback_mode}" -eq 1 ]]; then
          info "Rollback mode: leaving user '${PAI_USER}' and ${PAI_HOME} in place."
        else
          remove_user "${purge_data}"
        fi
        ;;
      *)
        warn "Unknown manifest kind '${kind}' for path '${path}' — skipping."
        ;;
    esac
  done

  if [[ "${needs_daemon_reload}" -eq 1 ]]; then
    # Never abort here: in a non-systemd environment (CI containers) the
    # reload cannot work, and the file removals above already succeeded.
    if systemctl daemon-reload 2>/dev/null; then
      info "systemd daemon reloaded."
    else
      warn "systemctl daemon-reload failed (non-systemd environment?) — continuing."
    fi
  fi

  remove_tailscale_serve

  # Full uninstall: archive the manifest so a second run does not reprocess
  # it, and clean up runtime artifacts that are never manifest-recorded
  # (single-flight lock, staged installer tmp, rate-limit counter). Rollback
  # keeps the manifest — a re-run of install.sh appends to it.
  if [[ "${rollback_mode}" -eq 0 ]]; then
    rm -f "${CFG_DIR}/.install.lock" "${STATE_DIR}/rate-limit.json" 2>/dev/null || true
    rm -rf "${STATE_DIR}/tmp" 2>/dev/null || true
    if [[ -f "${MANIFEST}" ]]; then
      mv "${MANIFEST}" "${MANIFEST}.uninstalled"
      info "Manifest archived to ${MANIFEST}.uninstalled"
    fi
    rmdir "${CFG_DIR}" "${STATE_DIR}" 2>/dev/null || true
  fi

  info "pai-anywhere uninstalled."
  if [[ "${rollback_mode}" -eq 0 ]]; then
    if [[ "${purge_data}" -eq 1 ]]; then
      printf '\n%b\n' "${YELLOW}Data purge was requested; ${PAI_HOME} removal handled above per confirmation.${NC}"
    else
      printf '\n%b\n' "${YELLOW}Note: PAI data under ${PAI_HOME}/.claude was preserved.${NC}"
      printf '%b\n' "${YELLOW}Remove it later if desired: sudo bash uninstall.sh --purge-data${NC}"
      printf '%b\n' "${YELLOW}                       or: rm -rf ${PAI_HOME}${NC}"
    fi
  fi
}

main "$@"
