#!/usr/bin/env bash
# Pre-mortem Scenario 2: partial-install state + rollback via uninstall.sh --rollback.
#
# Simulates install.sh failing mid-way (phases 1-8 done, phases 9+ not reached).
# Uses a synthetic manifest so no network access is required.
# Verifies uninstall.sh --rollback leaves no orphaned pai-anywhere files.
# Runs in CI containers as root.
# Usage: bash tests/partial-install-rollback.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CFG_DIR="/etc/pai-anywhere"
STATE_DIR="/var/lib/pai-anywhere"
APP_DIR="/opt/pai-anywhere"
MANIFEST="${CFG_DIR}/install-manifest.jsonl"
PAI_USER="pai"
PAI_HOME="/home/pai"

nuke_test_state() {
  systemctl stop pai-anywhere.service pai-pulse.service 2>/dev/null || true
  systemctl disable pai-anywhere.service pai-pulse.service 2>/dev/null || true
  rm -f /etc/systemd/system/pai-anywhere.service \
        /etc/systemd/system/pai-pulse.service 2>/dev/null || true
  rm -rf "${CFG_DIR}" "${STATE_DIR}" "${APP_DIR}" 2>/dev/null || true
  id -u "${PAI_USER}" &>/dev/null && userdel -r "${PAI_USER}" 2>/dev/null || true
}

if [[ "${EUID}" -ne 0 ]]; then
  printf '[skip] partial-install-rollback.sh: not running as root — CI container required\n' >&2
  exit 0
fi

# Start from a known-clean state
nuke_test_state 2>/dev/null || true

# ── Build a synthetic partial-install state (phases 1-8 done) ─────────────────
printf '[info] Creating synthetic partial install state...\n'

mkdir -p "${CFG_DIR}" "${STATE_DIR}" "${APP_DIR}/src"
touch "${MANIFEST}"

NOW="$(date -u +%FT%TZ)"
# Record mutations as install.sh would have (intent-log: recorded before creation)
printf '{"ts":"%s","kind":"directory","path":"%s","action":"create"}\n' "${NOW}" "${CFG_DIR}"    >> "${MANIFEST}"
printf '{"ts":"%s","kind":"directory","path":"%s","action":"create"}\n' "${NOW}" "${STATE_DIR}"  >> "${MANIFEST}"
printf '{"ts":"%s","kind":"directory","path":"%s","action":"create"}\n' "${NOW}" "${APP_DIR}"    >> "${MANIFEST}"
printf '{"ts":"%s","kind":"file","path":"%s","action":"create"}\n'      "${NOW}" "${CFG_DIR}/VERSION" >> "${MANIFEST}"
printf '{"ts":"%s","kind":"user","path":"%s","action":"create"}\n'      "${NOW}" "${PAI_HOME}"   >> "${MANIFEST}"
printf '{"ts":"%s","kind":"file","path":"%s","action":"create"}\n'      "${NOW}" "${PAI_HOME}/.claude/PAI/Pulse" >> "${MANIFEST}"
# systemd units are recorded with kind=systemd-service so rollback stops and
# disables them before deleting the unit file (regression guard: kind=file
# left the service running with old secrets in memory).
printf '{"ts":"%s","kind":"systemd-service","path":"%s","action":"create"}\n' "${NOW}" "/etc/systemd/system/pai-anywhere.service" >> "${MANIFEST}"

# Create corresponding artefacts
printf '0.1.0-partial\n' > "${CFG_DIR}/VERSION"
useradd --system --create-home --home-dir "${PAI_HOME}" \
  --shell /bin/bash --comment "pai-anywhere test account" "${PAI_USER}" 2>/dev/null || true
passwd -l "${PAI_USER}" 2>/dev/null || true
mkdir -p "${PAI_HOME}/.claude/PAI"
ln -s PULSE "${PAI_HOME}/.claude/PAI/Pulse"
touch "${APP_DIR}/src/cli.ts"
mkdir -p /etc/systemd/system
printf '[Unit]\nDescription=pai-anywhere test unit\n' > /etc/systemd/system/pai-anywhere.service

# ── Phases 9-15 did NOT run — no systemd units, no tailscale serve ─────────────
printf '[info] Partial state created; running uninstall.sh --rollback...\n'

# ── Run rollback ───────────────────────────────────────────────────────────────
bash "${REPO_ROOT}/uninstall.sh" --rollback

# ── Assert no orphaned service units ──────────────────────────────────────────
FAIL=0

for svc in /etc/systemd/system/pai-anywhere.service /etc/systemd/system/pai-pulse.service; do
  if [[ -f "${svc}" ]]; then
    printf '[FAIL] Orphaned systemd unit: %s\n' "${svc}" >&2
    FAIL=1
  fi
done

# Owned files inside target dirs should have been removed by rollback.
# Directories may persist if the manifest file itself (not recorded) is still there.
if [[ -f "${CFG_DIR}/VERSION" ]]; then
  printf '[FAIL] Owned file not removed by rollback: %s/VERSION\n' "${CFG_DIR}" >&2
  FAIL=1
fi

if [[ -d "${APP_DIR}" ]]; then
  printf '[FAIL] App bundle not removed by rollback: %s\n' "${APP_DIR}" >&2
  FAIL=1
fi

if [[ -L "${PAI_HOME}/.claude/PAI/Pulse" ]]; then
  printf '[FAIL] Managed symlink not removed by rollback: %s\n' "${PAI_HOME}/.claude/PAI/Pulse" >&2
  FAIL=1
fi

if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi

printf '[pass] No orphaned pai-anywhere files after partial-install rollback\n'
nuke_test_state 2>/dev/null || true
