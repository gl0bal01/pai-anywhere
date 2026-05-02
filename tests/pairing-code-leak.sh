#!/usr/bin/env bash
# AC-21: Pairing code does not appear in log output during the installation phases.
#
# generate_secrets() writes the code to /var/lib/pai-anywhere/pairing-code.txt
# (mode 0600) and emits only "Pairing code generated." to the log — never the
# raw value. The final print_done() banner displays it with a clear-screen so
# users are prompted to record it; the EXIT trap reminds them to run reset-access
# if scrollback was captured.
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

# The raw pairing code value must NOT appear in the installation-phase log lines.
# (print_done output is excluded by stopping capture before the interactive read.)
PAIRING_VALUE="$(cat "${PAIRING_FILE}")"
# Strip ANSI escape codes before grepping
STRIPPED_LOG="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_FILE}")"
if printf '%s\n' "${STRIPPED_LOG}" \
    | grep -v 'Pairing code:' \
    | grep -qF "${PAIRING_VALUE}"; then
  printf '[FAIL] pairing code value found in install log output\n' >&2
  exit 1
fi
printf '[pass] pairing code value not found in install log (outside final banner)\n'
