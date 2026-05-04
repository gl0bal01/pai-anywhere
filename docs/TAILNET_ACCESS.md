# Tailnet Access Control

pai-anywhere binds its gateway to `127.0.0.1` and exposes it via Tailscale Serve. The *only* network path to the gateway is through the tailnet. There is no public IP, no port forwarding, no Funnel. The threat surface is therefore whatever the tailnet itself permits.

This document is the operator-side companion to the gateway's pairing-code defence: the gateway already invalidates wrong codes and rate-limits attempts, but a tailnet that grants every device unrestricted reach to every other device still lets a compromised tailnet member knock on the gateway 10 times every 15 minutes, indefinitely. Tailscale ACLs / grants close that door at the network layer.

## Default tailnet model and why it matters

A fresh Tailscale tailnet is full-mesh: every authenticated device can reach every other device on every port. The pairing code + signed session cookie protect the gateway *application*, not the network port. Anything on the tailnet can:

- hit the pairing page and try codes (rate-limited but not banned)
- consume request budget on the loopback proxy
- probe `/__gateway/healthz` and any other gateway-local route

For a single-operator home VPS this may be acceptable. For shared tailnets (family members, contractors, IoT devices) it is not — you want the pai-anywhere device unreachable to all but explicitly-allowed identities.

## Recommended setup

Use device tags + grants. Tags survive reinstalls and key rotations; per-device-name policies do not.

### 1. Tag the VPS

Edit your tailnet policy (Tailscale admin → Access controls) to declare the tag:

```hujson
{
    "tagOwners": {
        "tag:pai-anywhere": ["autogroup:admin"],
    },
    // ...
}
```

Then, on the VPS, advertise the tag during `tailscale up` (replace any existing `--advertise-tags`):

```bash
sudo tailscale up --advertise-tags=tag:pai-anywhere
```

`tailscale status --self` should now show the device under `tag:pai-anywhere`. (If pai-anywhere's installer ran `tailscale up` for you, re-run with `--advertise-tags` appended; the installer never edits tailnet policy on its own.)

### 2. Grant only specific identities reach to the gateway

Add a grant block — replace the placeholders with your real identities:

```hujson
{
    "tagOwners": {
        "tag:pai-anywhere": ["autogroup:admin"],
    },

    "grants": [
        {
            "src": ["you@example.com"],
            "dst": ["tag:pai-anywhere"],
            "ip":  ["443"],
        },
    ],
}
```

Tailscale Serve listens on tailnet port 443 (the `https://<host>.<tailnet>.ts.net` URL), so `"ip": ["443"]` is what you want. If you also want SSH, add `"22"`. Keep the `dst` narrowed to the tag, not `*`.

### 3. (Optional) Lock SSH to your own identity

```hujson
{
    "ssh": [
        {
            "action": "check",
            "src":    ["you@example.com"],
            "dst":    ["tag:pai-anywhere"],
            "users":  ["root", "pai"],
        },
    ],
}
```

`action: check` requires Tailscale-side reauth, which means a stolen Tailscale token without a fresh login cannot SSH in.

## Verifying the policy

From a device that **should** have access:

```bash
curl -I https://<host>.<tailnet>.ts.net/__gateway/healthz
# expect: HTTP/2 200
```

From a device that **should not** (use a phone with Tailscale signed into a different account, or a tailnet member outside the grant):

```bash
tailscale ping <host>
# expect: pong (Tailscale layer is below the grant)

curl -I https://<host>.<tailnet>.ts.net/__gateway/healthz
# expect: connection refused / TLS handshake fails / 403 — not 200
```

Tailscale's admin panel also has a built-in policy preview: **Access controls → Preview**. Pick a source identity and a destination, and it will show whether the grant matches.

## Why not fail2ban for this?

A common reflex is to wire `fail2ban` against the gateway's auth-failure logs. For pai-anywhere this is the wrong layer:

- The gateway listens on `127.0.0.1`. From the kernel's perspective, the source address of every request is loopback. fail2ban's iptables actions cannot ban a tailnet identity — they would only ban `127.0.0.1`, breaking the whole gateway.
- The "real" source identity arrives only as Tailscale-injected request headers (e.g. `Tailscale-User-Login`). Acting on those means writing custom code that talks to the Tailscale API to revoke device access — which is exactly what a tailnet ACL grant already does, declaratively, at the right layer.
- The gateway already enforces a global pairing-attempt rate limit (`canAttemptPairing()`, 10 / 15 min). Per-IP banning adds little when the IP is uniformly loopback.

If you want adversarial isolation, use grants. If you want auditability, enable Tailscale's admin event log. fail2ban for pai-anywhere would be cosmetic.

## Related

- `docs/HARDENING.md` — checklist of network/gateway invariants the installer must preserve.
- `docs/THREAT_MODEL.md` — "Stolen tailnet device" and "Tailscale ACL mutation" threat rows.
- Tailscale documentation on tags and grants: <https://tailscale.com/kb/1068/acl-tags> and <https://tailscale.com/kb/1324/grants>.
