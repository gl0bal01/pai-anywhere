#!/usr/bin/env bash
# AC-20: Every manifest-recorded pai-anywhere-owned path must exist on disk after install.
# The manifest records both files and directories (e.g. /opt/pai-anywhere, /home/pai/.bun,
# /home/pai/.claude). A reverse symmetric diff against `find -type f` cannot work because
# the upstream PAI installer creates many files inside owned directories that are not
# individually recorded — only the parent directory is. Instead, verify that each manifest
# entry resolves to a real path.
# Runs in CI containers as root after a clean install.
# Usage: bash tests/manifest-completeness.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CFG_DIR="/etc/pai-anywhere"
MANIFEST="${CFG_DIR}/install-manifest.jsonl"
WORKDIR="$(mktemp -d)"

cleanup() { rm -rf "${WORKDIR}"; }
trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  printf '[skip] manifest-completeness.sh: not running as root — CI container required\n' >&2
  exit 0
fi

if ! command -v jq &>/dev/null; then
  printf '[skip] manifest-completeness.sh: jq not installed — skipping\n' >&2
  exit 0
fi

# ── Run install.sh ────────────────────────────────────────────────────────────
bash "${REPO_ROOT}/install.sh"

# ── Manifest paths must each exist on disk ────────────────────────────────────
MISSING="${WORKDIR}/missing.txt"
: > "${MISSING}"
recorded_count=0

while IFS=$'\t' read -r kind path; do
  [[ -z "${path}" ]] && continue
  recorded_count=$((recorded_count + 1))
  case "${kind}" in
    user)
      # 'user' kind records the home dir; uninstall removes via userdel -r
      [[ -d "${path}" ]] || printf '%s\t%s\n' "${kind}" "${path}" >> "${MISSING}"
      ;;
    file|directory)
      # Manifest 'file' kind covers both files and directories.
      [[ -e "${path}" || -L "${path}" ]] || printf '%s\t%s\n' "${kind}" "${path}" >> "${MISSING}"
      ;;
    *)
      printf '[warn] unknown manifest kind: %s (%s)\n' "${kind}" "${path}" >&2
      ;;
  esac
done < <(jq -r '[.kind, .path] | @tsv' "${MANIFEST}")

printf '[info] manifest-recorded paths: %d\n' "${recorded_count}"

if [[ -s "${MISSING}" ]]; then
  printf '[FAIL] Manifest references paths that do not exist after install:\n' >&2
  cat "${MISSING}" >&2
  exit 1
fi

printf '[pass] All manifest-recorded paths exist on disk\n'
