#!/usr/bin/env bash
# Regression: pai-anywhere reset-access must refuse non-root invocation.
#
# Without the guard, gateway-secrets.json (in stateDir, owned by pai) gets
# rewritten before the gateway.env writeAtomic in /etc/pai-anywhere/ fails with
# EACCES. That leaves session cookies invalidated but the pairing code stale —
# half-rotation. The CLI must check geteuid() and exit before any state mutation.
#
# Usage: bash tests/reset-access-non-root.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Part 1: source-level check (no root or bun required) ─────────────────────
# resetAccess() must invoke geteuid() before any of the state-mutating calls
# (mkdirSync, writeFileSync, writeAtomic, spawnSync, randomBytes-into-file, etc).
GUARD_OK="$(awk '
  /^function resetAccess/ { in_fn = 1; next }
  in_fn && /^[[:space:]]*\/\// { next }
  in_fn && /geteuid/ { print "guard"; exit }
  in_fn && /(writeAtomic|writeFileSync|mkdirSync|renameSync|spawnSync)/ { exit }
' "${REPO_ROOT}/src/cli.ts")"

if [[ "${GUARD_OK}" != "guard" ]]; then
  printf '[FAIL] resetAccess() lacks a geteuid() guard before state-mutating calls\n' >&2
  exit 1
fi
printf '[pass] resetAccess() guards with geteuid() before state mutation\n'

# ── Part 2: runtime check (skipped when run as root) ─────────────────────────
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  printf '[skip] runtime non-root check requires non-root user — skipping\n' >&2
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  printf '[skip] bun not on PATH — skipping runtime check\n' >&2
  exit 0
fi

OUTPUT=""
EXIT=0
OUTPUT="$(bun run "${REPO_ROOT}/src/cli.ts" reset-access 2>&1)" || EXIT=$?

if [[ "${EXIT}" -eq 0 ]]; then
  printf '[FAIL] non-root invocation should exit non-zero, got 0\n' >&2
  printf '       output: %s\n' "${OUTPUT}" >&2
  exit 1
fi
printf '[pass] non-root invocation exits non-zero (got %s)\n' "${EXIT}"

if ! grep -qiE 'must be run as root|requires root' <<<"${OUTPUT}"; then
  printf '[FAIL] non-root invocation did not print expected error message\n' >&2
  printf '       output: %s\n' "${OUTPUT}" >&2
  exit 1
fi
printf '[pass] non-root invocation prints root-required message\n'
