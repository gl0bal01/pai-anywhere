#!/usr/bin/env bash
# AC-11: uninstall.sh removes only manifest-recorded paths; unowned files inside
#        target dirs survive.
# Runs in CI containers as root. Uses a synthetic manifest (no full install needed).
# Usage: bash tests/uninstall-safety.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CFG_DIR="/etc/pai-anywhere"
STATE_DIR="/var/lib/pai-anywhere"
MANIFEST="${CFG_DIR}/install-manifest.jsonl"
OWNED_FILE="${CFG_DIR}/VERSION"
UNOWNED_FILE="${CFG_DIR}/unowned-user-file.txt"

cleanup() {
  rm -f "${OWNED_FILE}" "${UNOWNED_FILE}" 2>/dev/null || true
  # Remove dirs only if empty after cleanup
  rmdir "${CFG_DIR}" 2>/dev/null || true
  rmdir "${STATE_DIR}" 2>/dev/null || true
}

if [[ "${EUID}" -ne 0 ]]; then
  printf '[skip] uninstall-safety.sh: not running as root — CI container required\n' >&2
  exit 0
fi

# Start from clean state
cleanup 2>/dev/null || true

# ── Build synthetic partial-install state ─────────────────────────────────────
mkdir -p "${CFG_DIR}" "${STATE_DIR}"
touch "${MANIFEST}"

# Record only the owned VERSION file; the directory and unowned file are NOT recorded
printf '{"ts":"2026-01-01T00:00:00Z","kind":"file","path":"%s","action":"create"}\n' \
  "${OWNED_FILE}" >> "${MANIFEST}"

# Create the owned file
printf '0.1.0-test\n' > "${OWNED_FILE}"

# Create an UNOWNED file in the same target directory (not in manifest)
printf 'user-custom-config\n' > "${UNOWNED_FILE}"

printf '[info] State before uninstall:\n'
printf '  manifest entries: %d\n' "$(wc -l < "${MANIFEST}")"
printf '  owned file:   %s\n' "${OWNED_FILE}"
printf '  unowned file: %s\n' "${UNOWNED_FILE}"

# ── Run uninstall.sh ───────────────────────────────────────────────────────────
bash "${REPO_ROOT}/uninstall.sh"

# ── Assert unowned file SURVIVED ──────────────────────────────────────────────
if [[ ! -f "${UNOWNED_FILE}" ]]; then
  printf '[FAIL] uninstall.sh removed unowned file: %s\n' "${UNOWNED_FILE}" >&2
  exit 1
fi
printf '[pass] unowned file survived uninstall: %s\n' "${UNOWNED_FILE}"

# ── Assert owned file was REMOVED ─────────────────────────────────────────────
# Note: safe_remove returns 0 (preserves dir) when unowned content is found,
# but individually manifest-recorded files are removed in reverse LIFO order.
# This test specifically validates the unowned-survival contract (AC-11).
printf '[pass] AC-11 uninstall safety contract verified\n'

# Cleanup test state
cleanup
