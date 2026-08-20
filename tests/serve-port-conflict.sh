#!/usr/bin/env bash
# Regression: install.sh must not claim a tailnet HTTPS port that another
# service on the host already owns.
#
# Why this matters: `tailscale serve --https=443` makes tailscaled intercept
# peer traffic to the tailnet IP *inside netstack*, before any iptables/DNAT
# rule. A reverse proxy already published on 443 keeps answering locally and on
# public interfaces, so every naive check still says "healthy", while tailnet
# clients get a silent connection timeout. `tailscale serve status` cannot see
# that proxy, so port selection must probe the host directly.
#
# No root required. Functions are extracted from the real install.sh so this
# test fails if the implementation drifts.
# Usage: bash tests/serve-port-conflict.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKDIR="$(mktemp -d)"

LISTENER_PID=""
cleanup() {
  [[ -n "${LISTENER_PID}" ]] && kill "${LISTENER_PID}" 2>/dev/null || true
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

fail() { printf '[FAIL] %s\n' "$1" >&2; exit 1; }
pass() { printf '[pass] %s\n' "$1"; }

# ── load the real implementations out of install.sh ───────────────────────────
extract_fn() {
  awk -v fn="$1" '$0 ~ "^"fn"\\(\\) \\{" {p=1} p {print} p && /^\}$/ {exit}' \
    "${REPO_ROOT}/install.sh"
}

for fn in host_port_in_use serve_port_for_gateway; do
  body="$(extract_fn "${fn}")"
  [[ -n "${body}" ]] || fail "could not extract ${fn}() from install.sh"
  eval "${body}"
done
# Consumed by the eval'd serve_port_for_gateway(), invisible to shellcheck.
# shellcheck disable=SC2034
GATEWAY_PORT=8787
pass "extracted host_port_in_use() and serve_port_for_gateway() from install.sh"

# ── host_port_in_use() sees a real listener ───────────────────────────────────
command -v bun &>/dev/null || fail "bun is required to run this test"

BUSY_PORT=45871
FREE_PORT=45872

bun -e "Bun.serve({ port: ${BUSY_PORT}, fetch: () => new Response('busy') })" \
  >/dev/null 2>&1 &
LISTENER_PID=$!

for _ in {1..40}; do
  if host_port_in_use "${BUSY_PORT}"; then break; fi
  sleep 0.1
done

host_port_in_use "${BUSY_PORT}" \
  || fail "host_port_in_use() missed a live listener on ${BUSY_PORT}"
pass "host_port_in_use() detects an occupied port"

if host_port_in_use "${FREE_PORT}"; then
  fail "host_port_in_use() reported a free port ${FREE_PORT} as busy"
fi
pass "host_port_in_use() leaves a free port available"

# ── serve_port_for_gateway() reads the port off the real Serve JSON shape ─────
STUB_DIR="${WORKDIR}/bin"
mkdir -p "${STUB_DIR}"
cat > "${STUB_DIR}/tailscale" <<'STUB'
#!/usr/bin/env bash
# Mimics `tailscale serve status --json` for a gateway parked on a fallback port.
if [[ "$*" == *"serve status --json"* ]]; then
  cat <<'JSON'
{
  "TCP": { "10000": { "HTTPS": true } },
  "Web": {
    "host.tailnet.ts.net:10000": {
      "Handlers": { "/": { "Proxy": "http://127.0.0.1:8787" } }
    }
  }
}
JSON
  exit 0
fi
exit 0
STUB
chmod +x "${STUB_DIR}/tailscale"

got="$(PATH="${STUB_DIR}:${PATH}" serve_port_for_gateway)"
[[ "${got}" == "10000" ]] \
  || fail "serve_port_for_gateway() returned '${got}', expected '10000'"
pass "serve_port_for_gateway() recovers a non-443 Serve port"

# An unrelated Serve handler must not be mistaken for ours.
cat > "${STUB_DIR}/tailscale" <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == *"serve status --json"* ]]; then
  cat <<'JSON'
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "host.tailnet.ts.net:443": {
      "Handlers": { "/": { "Proxy": "http://127.0.0.1:9999" } }
    }
  }
}
JSON
  exit 0
fi
exit 0
STUB
chmod +x "${STUB_DIR}/tailscale"

got="$(PATH="${STUB_DIR}:${PATH}" serve_port_for_gateway)"
[[ -z "${got}" ]] \
  || fail "serve_port_for_gateway() claimed another service's handler (got '${got}')"
pass "serve_port_for_gateway() ignores a handler pointing elsewhere"

# ── install.sh must pass an explicit --https to tailscale serve ───────────────
if grep -qE 'tailscale serve --bg "http' "${REPO_ROOT}/install.sh"; then
  fail "install.sh calls 'tailscale serve --bg' with no --https; it silently defaults to 443"
fi
grep -qE 'tailscale serve --bg --https="\$\{port\}"' "${REPO_ROOT}/install.sh" \
  || fail "install.sh no longer passes an explicit --https port to tailscale serve"
pass "install.sh pins the Serve port explicitly"

printf '\n[OK] serve-port-conflict regression test passed\n'
