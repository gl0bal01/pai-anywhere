# pai-anywhere Hardening Checklist

V1 must be private by default. This checklist defines what install, verify, and release testing must prove before public use.

## Network

- No public PAI HTTP ports.
- Pulse listens only on `127.0.0.1:31337`.
- Gateway listens only on `127.0.0.1:<gateway-port>`.
- Tailscale Serve exposes only the loopback gateway to the tailnet.
- Tailscale Funnel is never enabled.
- `verify` must fail if Pulse is exposed on `0.0.0.0`, a non-loopback address, or if Funnel appears in Tailscale Serve status.

## Gateway

- `/healthz` may be unauthenticated.
- Protected routes must return `401` without a valid session cookie.
- Pairing requires a numeric code with rate-limited failed attempts.
- Session cookies are signed, HTTP-only, `SameSite=Strict`, and `Secure` in production.
- Pairing code is supplied through `/etc/pai-anywhere/gateway.env` with mode `0600`.
- `pai-anywhere reset-access --yes` rotates both the pairing code and session secret.
- Old gateway cookies must fail after reset-access and gateway restart.
- Logs must not include pairing codes, cookies, API keys, OAuth tokens, Tailscale auth keys, or private repo URLs.

## Host Config

- Existing user `~/.claude` is never modified by default.
- Official PAI installer runs as the dedicated unprivileged `pai` user.
- Managed PAI profile is `/home/pai/.claude`.
- Service runtime is copied to `/opt/pai-anywhere` only if that path is absent or manifest-owned.
- Host changes are additive and owned by pai-anywhere.
- Never rewrite these files wholesale:
  - `/etc/ssh/sshd_config`
  - `/etc/ufw/ufw.conf`
  - `/etc/fail2ban/jail.local`
  - existing user `~/.claude/settings.json`

## SSH And Firewall

- SSH hardening is opt-in.
- If SSH hardening is enabled, use `/etc/ssh/sshd_config.d/99-pai-anywhere.conf`.
- Validate SSH config with `sshd -t` before reload.
- Do not enable or tighten `ufw` unless SSH/current access safety is proven.
- Prefer owned ufw application profiles and additive rules.

## Rollback

- Every mutation must be recorded in `/etc/pai-anywhere/install-manifest.json`.
- Rollback removes only manifest-owned paths.
- Automatic rollback is allowlisted to pai-anywhere-owned config/state/app paths, pai-anywhere systemd units, and the specific Tailscale Serve off command.
- Managed PAI data under `/home/pai/.claude` is manual-review only; back it up before deleting.
- Missing manifest means rollback is a no-op.
- Invalid or secret-containing manifest blocks rollback until reviewed.

## Release Gate

Before public release:

- `doctor`, `install --dry-run`, `verify`, and `rollback --dry-run` pass expected smoke tests.
- Fresh install preserves pre-existing user `~/.claude` byte-for-byte.
- Gateway auth blocks unauthenticated protected requests.
- Pulse and gateway are loopback-only after reboot.
- Tailscale Serve works from one laptop and one mobile client.
- Two VPS providers pass the install matrix.
