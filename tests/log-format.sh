#!/usr/bin/env bash
# Observability: install.sh emits structured [phase=X status=Y] progress lines.
# Verifies the phase/phase_ok helper format and presence of required phase markers.
# No root required — inspects install.sh source only.
# Usage: bash tests/log-format.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_SH="${REPO_ROOT}/install.sh"

FAIL=0

# ── phase() emits [phase=%s status=start] ─────────────────────────────────────
if ! grep -qE '\[phase=%s status=start\]' "${INSTALL_SH}"; then
  printf '[FAIL] install.sh missing [phase=%%s status=start] format in phase()\n' >&2
  FAIL=1
else
  printf '[pass] phase() emits [phase=%%s status=start] format\n'
fi

# ── phase_ok() emits [phase=%s status=ok] ────────────────────────────────────
if ! grep -qE '\[phase=%s status=ok\]' "${INSTALL_SH}"; then
  printf '[FAIL] install.sh missing [phase=%%s status=ok] format in phase_ok()\n' >&2
  FAIL=1
else
  printf '[pass] phase_ok() emits [phase=%%s status=ok] format\n'
fi

# ── Required phases are present ───────────────────────────────────────────────
required_phases=(
  "preflight"
  "apt-deps"
  "tailscale"
  "pai-user"
  "bun"
  "fetch-pai"
  "pai-bootstrap"
  "gateway-app"
  "secrets"
  "systemd"
  "verify"
)

for phase in "${required_phases[@]}"; do
  if ! grep -q "phase_ok \"${phase}\"" "${INSTALL_SH}"; then
    printf '[FAIL] install.sh missing phase_ok "%s"\n' "${phase}" >&2
    FAIL=1
  else
    printf '[pass] phase_ok "%s" present\n' "${phase}"
  fi
done

# ── At least one phase call per required phase ────────────────────────────────
PHASE_OK_COUNT="$(grep -c 'phase_ok' "${INSTALL_SH}")"
if [[ "${PHASE_OK_COUNT}" -lt 5 ]]; then
  printf '[FAIL] install.sh has only %d phase_ok calls (expected >= 5)\n' \
    "${PHASE_OK_COUNT}" >&2
  FAIL=1
fi

if [[ "${FAIL}" -ne 0 ]]; then
  printf '[FAIL] log-format.sh: one or more checks failed\n' >&2
  exit 1
fi

printf '[pass] install.sh structured log format verified (%d phase_ok calls)\n' \
  "${PHASE_OK_COUNT}"
