#!/usr/bin/env bash
# pai-anywhere uninstall.sh — reverse only manifest-recorded mutations.
# Usage:  sudo bash uninstall.sh
#         sudo bash uninstall.sh --rollback   (called by install.sh ERR trap)
# Docs:   docs/QUICKSTART.md
set -euo pipefail

# ── config (must match install.sh) ────────────────────────────────────────────
PAI_USER="pai"
PAI_HOME="/home/pai"
APP_DIR="/opt/pai-anywhere"
CFG_DIR="/etc/pai-anywhere"
STATE_DIR="/var/lib/pai-anywhere"
MANIFEST="${CFG_DIR}/install-manifest.jsonl"

# Path prefix allowlist — uninstall may only act on these owned paths
ALLOWED_PREFIXES=(
  "${APP_DIR}"
  "${CFG_DIR}"
  "${STATE_DIR}"
  "${PAI_HOME}"
  "/etc/systemd/system/pai-anywhere.service"
  "/etc/systemd/system/pai-pulse.service"
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
      if ! echo "${manifest_paths}" | grep -qF "${child}"; then
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
  if id -u "${PAI_USER}" &>/dev/null; then
    # Only remove if user owns their home dir (not modified externally)
    local home_owner
    home_owner="$(stat -c '%U' "${PAI_HOME}" 2>/dev/null || echo "unknown")"
    if [[ "${home_owner}" != "${PAI_USER}" ]]; then
      warn "Home dir ${PAI_HOME} is owned by '${home_owner}', not '${PAI_USER}'."
      warn "Skipping user deletion. Manual review required."
      return 0
    fi
    userdel -r "${PAI_USER}" 2>/dev/null || {
      warn "userdel failed (user may have running processes). Skipping."
    }
    info "Removed user '${PAI_USER}' and home ${PAI_HOME}."
  fi
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
  if [[ "${1:-}" == "--rollback" ]]; then
    rollback_mode=1
    warn "Rollback mode: reversing partial install state."
  fi

  if [[ ! -f "${MANIFEST}" ]]; then
    if [[ "${rollback_mode}" -eq 1 ]]; then
      info "No manifest found — nothing to roll back."
      exit 0
    fi
    error "Manifest not found at ${MANIFEST}. Nothing to uninstall."
    exit 1
  fi

  # Validate every line is parseable JSON before acting
  local line_num=0
  while IFS= read -r line; do
    line_num=$((line_num + 1))
    [[ -z "${line}" ]] && continue
    if ! echo "${line}" | jq -e . &>/dev/null; then
      error "Corrupt manifest at line ${line_num}: ${line}"
      error "Manual review required. Aborting."
      exit 1
    fi
  done < "${MANIFEST}"

  info "Processing manifest: ${MANIFEST}"

  # Process entries in reverse order (LIFO). awk-reverse keeps this POSIX-clean —
  # tac is missing on some minimal container images (busybox builds without GNU coreutils).
  local entries
  entries="$(jq -r '[.kind, .path, .action] | @tsv' "${MANIFEST}" 2>/dev/null)"
  local reversed
  reversed="$(printf '%s\n' "${entries}" | awk '{a[NR]=$0} END {for (i=NR;i>=1;i--) print a[i]}')"

  local needs_daemon_reload=0

  while IFS=$'\t' read -r kind path _action; do
    [[ -z "${path}" ]] && continue
    case "${kind}" in
      file|directory)
        safe_remove "${path}"
        ;;
      systemd-service)
        local svc_name
        svc_name="$(basename "${path}")"
        disable_service "${svc_name}"
        needs_daemon_reload=1
        ;;
      user)
        # In rollback mode (called from install.sh ERR trap) leave the pai user
        # in place. The user/home may pre-date this install attempt or may hold
        # partially-installed PAI data the operator wants to inspect before manual
        # removal. Full uninstall still removes the user.
        if [[ "${rollback_mode}" -eq 1 ]]; then
          info "Rollback mode: leaving user '${PAI_USER}' and ${PAI_HOME} in place."
        else
          remove_user
        fi
        ;;
      *)
        warn "Unknown manifest kind '${kind}' for path '${path}' — skipping."
        ;;
    esac
  done <<< "${reversed}"

  if [[ "${needs_daemon_reload}" -eq 1 ]]; then
    systemctl daemon-reload
    info "systemd daemon reloaded."
  fi

  # Remove Tailscale Serve config if it points to our gateway
  if command -v tailscale &>/dev/null; then
    local serve_status
    serve_status="$(tailscale serve status 2>/dev/null || echo "")"
    if echo "${serve_status}" | grep -q "127.0.0.1:"; then
      tailscale serve reset 2>/dev/null || true
      info "Tailscale Serve config cleared."
    fi
  fi

  info "pai-anywhere uninstalled."
  if [[ "${rollback_mode}" -eq 0 ]]; then
    printf '\n%b\n' "${YELLOW}Note: PAI data under ${PAI_HOME}/.claude was NOT removed.${NC}"
    printf '%b\n' "${YELLOW}Remove it manually if desired: rm -rf ${PAI_HOME}/.claude${NC}"
  fi
}

main "$@"
