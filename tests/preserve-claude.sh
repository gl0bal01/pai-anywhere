#!/usr/bin/env bash
# AC-10: ~/.claude is byte-identical before and after install.
# Runs inside a podman/docker Ubuntu container as root with a seeded ~/.claude.
# Usage: bash tests/preserve-claude.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLAUDE_DIR="${HOME}/.claude"
BEFORE_FILE=""
AFTER_FILE=""

cleanup() {
  [[ -n "${BEFORE_FILE}" ]] && rm -f "${BEFORE_FILE}"
  [[ -n "${AFTER_FILE}" ]]  && rm -f "${AFTER_FILE}"
}
trap cleanup EXIT

# ── Prerequisites ──────────────────────────────────────────────────────────────
if [[ "${EUID}" -ne 0 ]]; then
  printf '[skip] preserve-claude.sh: not running as root — CI container required\n' >&2
  exit 0
fi

# ── Seed ~/.claude with known content ─────────────────────────────────────────
mkdir -p "${CLAUDE_DIR}/projects"
printf '{"version":"test-seed"}\n' > "${CLAUDE_DIR}/settings.json"
printf 'test-project-data\n'       > "${CLAUDE_DIR}/projects/test.txt"

# ── Snapshot BEFORE install ────────────────────────────────────────────────────
# NOTE: must use find+sort+xargs form — NOT sha256sum -r (non-portable flag)
BEFORE_FILE="$(mktemp)"
find "${CLAUDE_DIR}" -type f -print0 | sort -z | xargs -0 sha256sum > "${BEFORE_FILE}"
printf '[info] Captured %d file(s) in before-snapshot\n' \
  "$(wc -l < "${BEFORE_FILE}")"

# ── Run install.sh ─────────────────────────────────────────────────────────────
bash "${REPO_ROOT}/install.sh"

# ── Snapshot AFTER install ─────────────────────────────────────────────────────
AFTER_FILE="$(mktemp)"
find "${CLAUDE_DIR}" -type f -print0 | sort -z | xargs -0 sha256sum > "${AFTER_FILE}"

# ── Diff must be empty ─────────────────────────────────────────────────────────
if ! diff "${BEFORE_FILE}" "${AFTER_FILE}"; then
  printf '[FAIL] ~/.claude was modified by install.sh\n' >&2
  exit 1
fi

printf '[pass] ~/.claude is byte-identical before and after install\n'
