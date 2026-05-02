#!/usr/bin/env bash
# AC-1: paste-install works on fresh Ubuntu 22.04/24.04 via podman/docker container.
# Verifies: install.sh exits 0, manifest is non-empty, /opt/pai-anywhere exists.
# Prerequisites: podman or docker, network access to PAI installer + Tailscale.
# Usage: bash tests/container-install.sh [ubuntu:22.04|ubuntu:24.04|debian:12]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE="${1:-ubuntu:24.04}"

# ── Container runtime detection ───────────────────────────────────────────────
RUNTIME=""
if command -v podman &>/dev/null; then
  RUNTIME="podman"
elif command -v docker &>/dev/null; then
  RUNTIME="docker"
else
  printf '[skip] container-install.sh: neither podman nor docker found — skipping\n' >&2
  exit 0
fi

printf '[info] Using container runtime: %s\n' "${RUNTIME}"
printf '[info] Target image: %s\n' "${IMAGE}"

# ── Build a minimal container test script ────────────────────────────────────
TEST_SCRIPT="$(mktemp)"
cleanup() { rm -f "${TEST_SCRIPT}"; }
trap cleanup EXIT

cat > "${TEST_SCRIPT}" << 'INNER'
#!/usr/bin/env bash
set -euo pipefail
# Run install.sh (network must be available in the container)
bash /pai-anywhere/install.sh
# Verify manifest is non-empty
MANIFEST="/etc/pai-anywhere/install-manifest.jsonl"
if [[ ! -f "${MANIFEST}" ]]; then
  printf '[FAIL] manifest not found at %s\n' "${MANIFEST}" >&2
  exit 1
fi
lines="$(wc -l < "${MANIFEST}")"
if [[ "${lines}" -lt 1 ]]; then
  printf '[FAIL] manifest is empty\n' >&2
  exit 1
fi
printf '[pass] manifest has %d entries\n' "${lines}"
# Verify /opt/pai-anywhere exists
if [[ ! -d /opt/pai-anywhere ]]; then
  printf '[FAIL] /opt/pai-anywhere not found\n' >&2
  exit 1
fi
printf '[pass] /opt/pai-anywhere exists\n'
printf '[pass] container-install.sh: install.sh exited 0 on %s\n' "$(. /etc/os-release && printf '%s %s' "${ID}" "${VERSION_ID}")"
INNER
chmod +x "${TEST_SCRIPT}"

# ── Run install inside a fresh container ─────────────────────────────────────
"${RUNTIME}" run --rm \
  --privileged \
  --volume "${REPO_ROOT}:/pai-anywhere:ro" \
  --volume "${TEST_SCRIPT}:/run-test.sh:ro" \
  "${IMAGE}" \
  bash /run-test.sh

printf '[pass] container-install.sh completed successfully for %s\n' "${IMAGE}"
