#!/usr/bin/env bash
# AC-21: Pairing code does not appear in log output during the installation phases.
#
# generate_secrets() writes the code to /var/lib/pai-anywhere/pairing-code.txt
# (mode 0600) and emits only "Pairing code generated." to the log — never the
# raw value. The final print_done() banner displays the raw code ONLY to an
# interactive terminal ([[ -t 1 ]]); piped/captured output gets a pointer to the
# 0600 file. The EXIT trap reminds users to run reset-access if scrollback leaked.
#
# This test verifies the generation phase does not leak the value.
# Usage: bash tests/pairing-code-leak.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Part 1: source-level check (no root required) ─────────────────────────────
# Verify generate_secrets() does not echo/printf the $pairing variable to stdout.
# The only allowed use of $pairing is redirecting it into a file (> pairing-file).

# Extract generate_secrets body and look for any stdout emission of $pairing
GENERATE_BODY="$(awk '/^generate_secrets\(\)/{found=1} found{print} found && /^}$/{exit}' \
  "${REPO_ROOT}/install.sh")"

# A leak would be: printf/echo on a line that references $pairing without '>'
if printf '%s\n' "${GENERATE_BODY}" | grep -v '#' | grep -v '>' \
    | grep -qE '(printf|echo).*\$pairing'; then
  printf '[FAIL] generate_secrets() appears to print $pairing to stdout\n' >&2
  exit 1
fi
printf '[pass] generate_secrets() does not print pairing code to stdout\n'

# Verify pairing-code.txt gets chmod 0600
if ! printf '%s\n' "${GENERATE_BODY}" | grep -q 'chmod 0600.*pairing'; then
  printf '[FAIL] generate_secrets() does not set 0600 on pairing-code.txt\n' >&2
  exit 1
fi
printf '[pass] generate_secrets() sets mode 0600 on pairing-code.txt\n'

# ── Part 1b: source-level tty-gating + no /tmp log (A2 / A3) ───────────────────
# A3: the Tailscale auth URL must never be tee'd to a world-readable /tmp file.
if grep -qE 'tee[[:space:]]+/tmp/tailscale-up\.log' "${REPO_ROOT}/install.sh"; then
  printf '[FAIL] install.sh tees the tailscale auth URL to world-readable /tmp\n' >&2
  exit 1
fi
printf '[pass] install.sh does not persist the tailscale auth URL to /tmp\n'

# A2: print_done() must gate the raw pairing code on an interactive terminal.
PRINTDONE_BODY="$(awk '/^print_done\(\)/{found=1} found{print} found && /^}$/{exit}' \
  "${REPO_ROOT}/install.sh")"
if ! printf '%s\n' "${PRINTDONE_BODY}" | grep -q '\-t 1'; then
  printf '[FAIL] print_done() does not tty-gate the pairing-code display\n' >&2
  exit 1
fi
if ! printf '%s\n' "${PRINTDONE_BODY}" | grep -q 'hidden'; then
  printf '[FAIL] print_done() has no non-interactive pairing-code fallback\n' >&2
  exit 1
fi
printf '[pass] print_done() shows the raw pairing code only to an interactive tty\n'

# ── Part 2: runtime check (root, CI container) ────────────────────────────────
if [[ "${EUID}" -ne 0 ]]; then
  printf '[skip] runtime pairing-code-leak check requires root — skipping\n' >&2
  exit 0
fi

STATE_DIR="/var/lib/pai-anywhere"
PAIRING_FILE="${STATE_DIR}/pairing-code.txt"
LOG_FILE="$(mktemp)"
cleanup() { rm -f "${LOG_FILE}"; }
trap cleanup EXIT

# Run install; capture all output (stdout + stderr) in the log
bash "${REPO_ROOT}/install.sh" > "${LOG_FILE}" 2>&1 || true

# Pairing code file must exist with 0600 permissions
if [[ ! -f "${PAIRING_FILE}" ]]; then
  printf '[FAIL] pairing-code.txt not found at %s\n' "${PAIRING_FILE}" >&2
  exit 1
fi

PERMS="$(stat -c '%a' "${PAIRING_FILE}")"
if [[ "${PERMS}" != "600" ]]; then
  printf '[FAIL] pairing-code.txt has mode %s, expected 600\n' "${PERMS}" >&2
  exit 1
fi
printf '[pass] pairing-code.txt exists with mode 600\n'

# The raw pairing code value must NOT appear ANYWHERE in captured (non-tty)
# output. Output here is redirected to a file, so print_done()'s tty-gate
# suppresses the raw code entirely — no banner exclusion is needed any more.
PAIRING_VALUE="$(cat "${PAIRING_FILE}")"
# Strip ANSI escape codes before grepping
STRIPPED_LOG="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_FILE}")"
if printf '%s\n' "${STRIPPED_LOG}" | grep -qF "${PAIRING_VALUE}"; then
  printf '[FAIL] pairing code value found in captured install output\n' >&2
  exit 1
fi
printf '[pass] pairing code value never appears in captured (non-tty) output\n'
