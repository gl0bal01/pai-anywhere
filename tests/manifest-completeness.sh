#!/usr/bin/env bash
# AC-20: Every pai-anywhere-owned mutation is recorded in the JSONL manifest.
# Uses scope-anchored find (per plan §Verification step 9) to avoid false positives
# from apt/dpkg/systemd transitive side-effects.
# Runs in CI containers as root after a clean install.
# Usage: bash tests/manifest-completeness.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CFG_DIR="/etc/pai-anywhere"
STATE_DIR="/var/lib/pai-anywhere"
APP_DIR="/opt/pai-anywhere"
MANIFEST="${CFG_DIR}/install-manifest.jsonl"
PREFLIGHT_MARKER="/tmp/pai-manifest-test-marker"
WORKDIR="$(mktemp -d)"

cleanup() { rm -rf "${WORKDIR}" "${PREFLIGHT_MARKER}"; }
trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  printf '[skip] manifest-completeness.sh: not running as root — CI container required\n' >&2
  exit 0
fi

if ! command -v jq &>/dev/null; then
  printf '[skip] manifest-completeness.sh: jq not installed — skipping\n' >&2
  exit 0
fi

# ── Mark start time ───────────────────────────────────────────────────────────
touch "${PREFLIGHT_MARKER}"

# ── Run install.sh ────────────────────────────────────────────────────────────
bash "${REPO_ROOT}/install.sh"

# ── Scope-anchored find: only pai-anywhere-owned prefixes (AC-20) ─────────────
# Excludes: apt/dpkg/systemd transitive side-effects, target.wants symlinks, etc.
FS_ACTUAL="${WORKDIR}/fs-actual.txt"
find \
  "${CFG_DIR}" \
  "${STATE_DIR}" \
  "${APP_DIR}" \
  /home/pai \
  /etc/systemd/system/pai-pulse.service \
  /etc/systemd/system/pai-anywhere.service \
  -newer "${PREFLIGHT_MARKER}" -type f 2>/dev/null \
  | sort > "${FS_ACTUAL}"

# ── Manifest-recorded paths ───────────────────────────────────────────────────
MANIFEST_RECORDED="${WORKDIR}/manifest-recorded.txt"
jq -r '.path' "${MANIFEST}" 2>/dev/null | sort -u > "${MANIFEST_RECORDED}"

printf '[info] filesystem newer files (scoped): %d\n' "$(wc -l < "${FS_ACTUAL}")"
printf '[info] manifest-recorded paths:         %d\n' "$(wc -l < "${MANIFEST_RECORDED}")"

# ── Symmetric diff must be empty ──────────────────────────────────────────────
DIFF_OUT="${WORKDIR}/diff.txt"
diff "${FS_ACTUAL}" "${MANIFEST_RECORDED}" > "${DIFF_OUT}" || true

if [[ -s "${DIFF_OUT}" ]]; then
  printf '[FAIL] Manifest completeness check failed — symmetric diff non-empty:\n' >&2
  cat "${DIFF_OUT}" >&2
  exit 1
fi

printf '[pass] All scoped filesystem mutations are recorded in the manifest\n'
