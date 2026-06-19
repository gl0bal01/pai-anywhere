#!/usr/bin/env bash
# Regression: uninstall.sh must NOT destroy managed PAI data or wipe unrelated
# Tailscale Serve routes during a default full uninstall.
#   B1: default uninstall removes the account only; /home/pai (incl. .claude) is
#       preserved. Home deletion requires --purge-data + interactive consent.
#   B2: `tailscale serve reset` (global) must never run when OTHER loopback
#       routes are present.
# Source-level checks (no root / no real install needed), in the style of
# tests/pairing-code-leak.sh.
# Usage: bash tests/uninstall-preserve-data.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
U="${SCRIPT_DIR}/../uninstall.sh"
fail=0
pass() { printf '[pass] %s\n' "$*"; }
bad()  { printf '[FAIL] %s\n' "$*" >&2; fail=1; }

[[ -f "${U}" ]] || { printf '[FAIL] uninstall.sh not found\n' >&2; exit 1; }

# ── B1: no unconditional data destruction ─────────────────────────────────────
# `userdel -r` (which deletes the home) must be gated behind --purge-data.
if grep -nE 'userdel[[:space:]]+-r' "${U}" >/dev/null; then
  # It may exist, but only inside the purge_data branch. Assert the flag exists
  # and the default branch uses account-only `userdel` (no -r).
  grep -q -- '--purge-data' "${U}" \
    || bad "uninstall.sh uses 'userdel -r' but has no --purge-data flag/gate."
  # The recommended-by-default user removal must be account-only.
  grep -qE 'userdel[[:space:]]+"\$\{PAI_USER\}"' "${U}" \
    || bad "default uninstall must remove the account only (userdel without -r)."
  pass "B1: home deletion (userdel -r) is gated behind --purge-data"
else
  pass "B1: uninstall.sh never calls 'userdel -r'"
fi

# The user-facing note must NOT claim data was preserved while deleting it.
if grep -q 'NOT removed' "${U}"; then
  bad "uninstall.sh still prints the misleading 'NOT removed' note."
else
  pass "B1: no misleading 'NOT removed' note"
fi
grep -q 'was preserved' "${U}" \
  || bad "default uninstall should tell the operator the PAI data was preserved."
[[ "${fail}" -eq 0 ]] && pass "B1: default uninstall preserves /home/pai/.claude"

# ── B2: no blind global Serve reset ───────────────────────────────────────────
if grep -qE 'tailscale serve reset' "${U}"; then
  # A reset is allowed only after checking there are no OTHER loopback routes.
  grep -q 'Refusing global' "${U}" \
    || bad "tailscale serve reset is present but the 'other routes' guard is missing."
  grep -qE 'grep -oE .127' "${U}" \
    || bad "serve cleanup must enumerate loopback routes before any reset."
  pass "B2: 'tailscale serve reset' is guarded against wiping other routes"
else
  pass "B2: uninstall.sh does not call 'tailscale serve reset'"
fi

if [[ "${fail}" -ne 0 ]]; then
  printf '\n[FAIL] uninstall-preserve-data.sh: one or more checks failed\n' >&2
  exit 1
fi
printf '\n[ok] uninstall data/route preservation contract verified\n'
