#!/usr/bin/env bash
# AC-6: SHA-256 verification in install.sh correctly aborts on hash mismatch.
#
# Part 1 (no root): unit-tests the sha256_verify logic in isolation.
# Part 2 (root, CI container): runs install.sh with a mock curl returning fake
#   content. The mocked download hash never matches the real pinned hashes in
#   install.sh — install.sh must exit non-zero before creating /opt/pai-anywhere.
#
# Usage: bash tests/sha256-mismatch.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKDIR="$(mktemp -d)"

cleanup() { rm -rf "${WORKDIR}"; }
trap cleanup EXIT

# ── Part 1: sha256_verify logic rejects wrong hash (no root required) ─────────

FAKE_FILE="${WORKDIR}/fake-installer.sh"
printf '#!/usr/bin/env bash\necho fake\n' > "${FAKE_FILE}"

CORRECT_HASH="$(sha256sum "${FAKE_FILE}" | awk '{print $1}')"
WRONG_HASH="0000000000000000000000000000000000000000000000000000000000000000"

# Inline the same logic used by install.sh sha256_verify()
check_hash() {
  local file="$1" expected="$2"
  local actual
  actual="$(sha256sum "${file}" | awk '{print $1}')"
  [[ "${actual}" == "${expected}" ]]
}

if check_hash "${FAKE_FILE}" "${WRONG_HASH}"; then
  printf '[FAIL] hash check accepted wrong hash\n' >&2
  exit 1
fi
printf '[pass] hash check correctly rejects wrong hash\n'

if ! check_hash "${FAKE_FILE}" "${CORRECT_HASH}"; then
  printf '[FAIL] hash check rejected correct hash\n' >&2
  exit 1
fi
printf '[pass] hash check accepts correct hash\n'

# ── Part 2: install.sh exits non-zero when download hash mismatches (root) ────

if [[ "${EUID}" -ne 0 ]]; then
  printf '[skip] install.sh integration check requires root — skipping\n' >&2
  exit 0
fi

# Create a mock curl that writes known fake content to the -o destination.
# install.sh pins real hashes for PAI installer + Bun tarballs; the mocked
# fake content will never match — sha256_verify aborts before /opt/pai-anywhere.
mkdir -p "${WORKDIR}/bin"
MOCK_CURL="${WORKDIR}/bin/curl"
cat > "${MOCK_CURL}" << 'MOCK'
#!/usr/bin/env bash
# Fake curl: write dummy content to the -o destination; exit 0.
idx=1
while [[ ${idx} -le $# ]]; do
  arg="${!idx}"
  if [[ "${arg}" == "-o" ]]; then
    idx=$(( idx + 1 ))
    printf 'fake-download-content\n' > "${!idx}"
  fi
  idx=$(( idx + 1 ))
done
exit 0
MOCK
chmod +x "${MOCK_CURL}"

export PATH="${WORKDIR}/bin:${PATH}"

install_exit=0
bash "${REPO_ROOT}/install.sh" || install_exit=$?

if [[ "${install_exit}" -eq 0 ]]; then
  printf '[FAIL] install.sh should exit non-zero on SHA-256 mismatch\n' >&2
  exit 1
fi
printf '[pass] install.sh exited non-zero on SHA-256 mismatch (exit %d)\n' \
  "${install_exit}"

if [[ -d /opt/pai-anywhere ]]; then
  printf '[FAIL] /opt/pai-anywhere was created despite SHA-256 mismatch\n' >&2
  exit 1
fi
printf '[pass] /opt/pai-anywhere not created — mutations stopped before install_gateway_app\n'
