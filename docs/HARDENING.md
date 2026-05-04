# pai-anywhere Hardening Checklist

V1 must be private by default. This checklist defines what install, verify, and release testing must prove before public use.

## Network

- No public PAI HTTP ports.
- Pulse listens only on `127.0.0.1:31337`.
- Gateway listens only on `127.0.0.1:<gateway-port>`.
- Tailscale Serve exposes only the loopback gateway to the tailnet.
- Tailscale Funnel is never enabled.
- `verify` must fail if Pulse is exposed on `0.0.0.0`, a non-loopback address, or if Funnel appears in Tailscale Serve status.
- Restrict tailnet reach to the gateway with Tailscale grants. See [TAILNET_ACCESS](./TAILNET_ACCESS.md) for the recommended tag + grant policy and why per-IP banning (e.g. fail2ban) is the wrong layer for a loopback-bound, tailnet-only service.

## Gateway

- `/healthz` may be unauthenticated.
- Protected routes must return `401` without a valid session cookie.
- Pairing requires a numeric code with rate-limited failed attempts.
- Session cookies are signed, HTTP-only, `SameSite=Strict`, and `Secure` in production.
- Pairing code is supplied through `/etc/pai-anywhere/gateway.env` with mode `0600`.
- `sudo pai-anywhere reset-access` rotates both the pairing code and session secret. Must run as root because `gateway.env` lives in the root-owned `/etc/pai-anywhere/` directory; the CLI refuses to run as a non-root user to avoid half-rotation (session secret rotated in state dir, but `gateway.env` write fails with EACCES, leaving the pairing code unchanged).
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

## Encrypted Backups

The installer ships `/usr/local/sbin/pai-backup` plus `pai-backup.timer` for daily age-encrypted snapshots of `home/pai/.claude`, `etc/pai-anywhere`, and `var/lib/pai-anywhere`. Off-site push is opt-in via `/etc/pai-anywhere/backup-offsite.env`.

When wiring off-site backup, prefer the following operator pattern:

- **Dedicated bucket** (e.g. `pai-anywhere-backups`) — do not share with unrelated workloads. R2 returns `404 NoSuchBucket` (not `403`) when a token cannot see a bucket; a successful write to bucket X with a token meant to be scoped to bucket Y proves the token's actual scope is wrong.
- **Dedicated, bucket-scoped API token.** Object Read+Write on the backup bucket only. VPS compromise then leaks only backup creds, not other R2 workloads.
- **Per-service rclone config** at `/etc/pai-anywhere/rclone.conf` (mode `0600`, owned `root:root`). Do not reuse `~/.config/rclone/rclone.conf` from a regular user — the per-service config keeps the service token blast radius separate from interactive use.
- **Export `RCLONE_CONFIG` from `backup-offsite.env`**, e.g.:
  ```
  REMOTE=r2-pai:pai-anywhere-backups/pai-anywhere
  export RCLONE_CONFIG=/etc/pai-anywhere/rclone.conf
  ```
  `pai-backup` sources this file, so the export reaches the rclone subprocess.
- **No double encryption.** The tarball is already age-encrypted; a raw S3-compatible remote is sufficient. Skip rclone crypt for the off-site target.
- **Smoke-test restore at least once.** Download the latest blob, decrypt with the age identity, list with `tar -tzf`. If this round-trip fails, the backup is theatre.

The age private key (`/root/.config/pai-backup/identity.txt`) is the entire decryption authority. After confirming back-ups are pushing off-site, store the identity in an offline vault (password manager labelled `pai-backup-identity`, plus at least one second copy on encrypted media or paper) and `shred -u` the on-box copy. Backups continue to encrypt against `recipient.pub`. VPS compromise after this yields ciphertext only.

If the operator deploys via a Claude Code or similar transcripted agent, treat any prior session that contained the identity, R2 credentials, or rclone-crypt password as compromised — rotate the affected secrets even after the agent transcript is closed, since `~/.claude/projects/**.jsonl` and `~/.claude/file-history/**` retain the values on disk.

## Release Gate

Before public release:

- `doctor`, `install --dry-run`, `verify`, and `rollback --dry-run` pass expected smoke tests.
- Fresh install preserves pre-existing user `~/.claude` byte-for-byte.
- Gateway auth blocks unauthenticated protected requests.
- Pulse and gateway are loopback-only after reboot.
- Tailscale Serve works from one laptop and one mobile client.
- Two VPS providers pass the install matrix.
