# pai-anywhere Threat Model

## Security Goal

`pai-anywhere` protects a single user's PAI installation on a private host.

PAI data is sensitive. The installer must optimize for confidentiality, recoverability, and avoiding accidental exposure over convenience.

## Assets

- Existing host `~/.claude` directory.
- Managed PAI profile at `/home/pai/.claude`.
- Claude Code OAuth/session state.
- Future runtime adapter auth/config for OpenCode or OpenAgent.
- Anthropic, ElevenLabs, GitHub, and other API tokens.
- Private PAI repo URL.
- Pulse dashboard data.
- Terminal access to the PAI host.
- PAI memory, user identity, preferences, and work history.
- Installer logs, manifests, and backups.
- pai-anywhere service runtime at `/opt/pai-anywhere`.

## Trust Boundaries

```text
Public internet
  untrusted

Tailscale tailnet
  trusted for transport only
  not sufficient for terminal access

pai-anywhere gateway
  must authenticate browser sessions with pairing code + signed cookie

Host loopback
  Pulse and terminal bridge live here

Managed profile
  /home/pai/.claude, owned by the dedicated pai account

Existing user profile
  ~/.claude, not owned by pai-anywhere
```

## Default Network Posture

- Pulse binds to `127.0.0.1:31337`.
- Gateway binds to `127.0.0.1`.
- Tailscale Serve exposes only the gateway to the tailnet.
- Tailscale Funnel is forbidden.
- No public HTTP port is opened.
- SSH is not tightened or closed unless the user explicitly approves and a safety check passes.

## Primary Threats

| Threat | Risk | Required mitigation |
|---|---|---|
| Public Pulse exposure | Leaks dashboard, hook routes, and notifications | Verify Pulse loopback bind; block `0.0.0.0`; doctor flags exposure |
| Public terminal exposure | Full host compromise | Gateway loopback only; private Serve only; pairing code auth; signed cookie |
| Stolen tailnet device | Attacker reaches private URL | Pairing code/session cookie required in addition to tailnet |
| Existing `~/.claude` clobber | User loses config or leaks private PAI data | Run official installer as dedicated `pai` account; preservation test |
| SSH lockout | User loses server access | Never enable/tighten firewall unless allow rules and reachability are proven |
| Secret leakage in logs | Tokens/private URLs persist on disk | Redaction layer; no echoing private repo URL; secret grep tests |
| Unsafe firewall rewrite | Breaks services or lockout | Owned rules/drop-ins only; skip if uncertain |
| Tailscale ACL mutation error | Tailnet access broken or widened | No automatic ACL edits in V1 |
| Tailscale Funnel enabled | Public exposure | Never call Funnel; doctor checks Serve/Funnel status |
| Browser terminal abuse | Tailnet user gains shell | Pairing code; session timeout; reset-access rotation; command scope review |
| Runtime adapter secret sprawl | OpenCode/OpenAgent provider tokens leak or mix with Claude profile | Out of V1; future adapters use isolated config roots |
| Rollback damage | Uninstaller removes user files | Manifest-owned removals only; never delete unknown files |
| App bundle overwrite | Existing `/opt/pai-anywhere` content lost | Refuse unowned app bundle path; record owned app bundle in manifest |

## Installation Rules

The installer must:

- Run `doctor`-equivalent checks before mutation.
- Surface intended phases before mutation. (`install --dry-run` flag deferred to v0.3; v0.1 installer is idempotent bash and prints each phase before acting.)
- Check whether Bun, Git, Tailscale, fail2ban, and ufw already exist before installation.
- Reuse existing dependencies where safe.
- Never overwrite host config files wholesale.
- Prefer owned drop-ins:
  - `/etc/systemd/system/pai-anywhere.service`
  - `/etc/systemd/system/pai-pulse.service`
  - `/etc/fail2ban/jail.d/pai-anywhere-sshd.local`
  - `/etc/ufw/applications.d/pai-anywhere`
- Refuse to overwrite `/opt/pai-anywhere` unless it is already manifest-owned.
- Record every created/modified path in an install manifest.
- Make backups before any explicit advanced-mode file edit.
- Validate SSH config with `sshd -t` before reload.
- Refuse or skip unsafe firewall changes.

The installer must not:

- Delete, move, or rewrite existing `~/.claude` by default.
- Store private repo URLs.
- Store Tailscale auth keys.
- Store OAuth/API tokens outside the upstream PAI profile/config paths.
- Add public HTTP listeners.
- Enable Tailscale Funnel.
- Mount `~/.claude` into Docker.
- Edit Tailscale ACLs automatically.
- Configure OpenCode, OpenAgent, or third-party model providers in V1.

## Existing `~/.claude` Preservation

Default install:

```bash
sudo -u pai -H bash <official-pai-installer>
# PAI profile resolves to /home/pai/.claude
```

Required verification:

1. Pre-create or detect existing `~/.claude`.
2. Snapshot file list + hashes before install.
3. Run install.
4. Confirm `~/.claude` is byte-for-byte unchanged.

Advanced migration mode may touch existing `~/.claude` only after:

- explicit confirmation,
- timestamped backup,
- structural JSON merge for `settings.json`,
- manifest entry,
- rollback plan.

## Gateway Auth

Tailnet access is not enough.

The gateway must require:

- one-time pairing code printed in the terminal,
- signed HTTP-only session cookie,
- local secret stored with `0600` permissions,
- `pai-anywhere reset-access` to rotate secrets and invalidate sessions.

Recommended V1 defaults:

- pairing code expires quickly,
- session cookie expires,
- failed pairing attempts are rate-limited,
- logs do not include pairing code or cookie values.

## Runtime Adapters

OpenCode, oh-my-openagent, and provider/model routing are out of V1.

Future adapters must be isolated:

```text
/home/pai/.claude
/var/lib/pai-anywhere/runtimes/opencode
/var/lib/pai-anywhere/runtimes/openagent
```

Security rules:

- Do not read or mutate existing `~/.config/opencode` by default.
- Do not read or mutate existing `~/.claude` by default.
- Do not share provider tokens between runtimes implicitly.
- Do not add provider setup to the default installer.
- Add `doctor` checks before enabling any runtime adapter.
- Keep runtime selection explicit.

## Doctor Checks

`pai-anywhere doctor` must be read-only and report:

- dependency presence and versions,
- Tailscale installed/running/logged-in state,
- Tailscale Serve/Funnel status,
- public listening ports,
- Pulse bind address,
- gateway bind address,
- ufw status without changing it,
- fail2ban status without changing it,
- SSH config drop-ins related to pai-anywhere,
- existence and integrity of `~/.claude`,
- managed profile state,
- manifest state,
- likely secret leakage in logs/state.

## Implementation Mapping (v0.1)

Each threat row maps to the file/lines that mitigate it.

| Threat | Mitigation in code |
|---|---|
| Public Pulse exposure | `install.sh` `tailscale_serve_private()`; `install.sh` `write_systemd_units()` sets `Environment=PAI_PULSE_BIND_ALL=0` in pai-pulse.service; `src/doctor/probes.ts` pulse_loopback probe |
| Public terminal exposure | `src/gateway/server.ts` `/terminal` returns 410; loopback bind enforced in `startGateway()` `isLoopbackHost()` |
| Stolen tailnet device | `src/gateway/auth.ts` HMAC-signed cookie + base64url pairing code; rate limit `canAttemptPairing()` 10/15min global |
| Existing `~/.claude` clobber | `install.sh` `run_pai_as_pai()` runs upstream installer as `pai` user; `tests/preserve-claude.sh` snapshot diff |
| SSH lockout | `install.sh` does not modify `/etc/ssh/sshd_config` in v0.1 baseline; `docs/HARDENING.md` documents drop-in pattern |
| Secret leakage in logs | `install.sh` writes pairing code only to `/var/lib/pai-anywhere/pairing-code.txt` (0600); never echoed; `tests/pairing-code-leak.sh` enforces |
| Unsafe firewall rewrite | `install.sh` does not enable/configure `ufw` rules in v0.1; status-only check in `doctor` |
| Tailscale ACL mutation | not implemented in v0.1; `install.sh` only calls `tailscale up` and `tailscale serve` |
| Tailscale Funnel enabled | `install.sh` `tailscale_serve_private()` aborts if Funnel detected via `tailscale serve status` |
| Browser terminal abuse | `/terminal` returns 410 (`src/gateway/server.ts`); deferred to v0.2 |
| Runtime adapter secret sprawl | not in v0.1 scope |
| Rollback damage | `uninstall.sh` allowlist + JSONL manifest at `/etc/pai-anywhere/install-manifest.jsonl`; `tests/uninstall-safety.sh` |
| App bundle overwrite | `install.sh` `install_gateway_app()` refuses unowned `/opt/pai-anywhere`; preflight check |
| Upstream installer compromise | `install.sh` `fetch_and_verify_pai()` SHA-256 verifies against pinned hash; `scripts/pin-installer.sh` + `.github/workflows/pin-bot.yml` weekly PR; `.github/CODEOWNERS` requires review |
| Pulse path drift | `src/gateway/server.ts proxyPulse()` proxies all paths to Pulse on `127.0.0.1:31337` (Pulse owns its routing); rejects `/__gateway/*` + path-traversal; method allowlist (`GET`/`POST`/`HEAD`); 1MB body cap |
| Bash idempotency drift | `set -euo pipefail` + `if-not-already-X` gates per function in `install.sh`; `.github/workflows/shellcheck.yml` CI gate |
| Bun supply chain | `install.sh` `install_bun_for_pai()` SHA-256 verifies tarball by arch against `BUN_SHA256_X86_64`/`BUN_SHA256_ARM64` constants |
| Tailscale supply chain | `install.sh` `install_tailscale_apt()` uses signed apt repo (keyring at `/usr/share/keyrings/tailscale-archive-keyring.gpg`); never `curl|sh` |

---

## Done Criteria

V1 is not release-ready until:

- `doctor` exists.
- default install preserves existing `~/.claude`.
- Pulse and gateway are loopback-only.
- Tailscale Serve is private and Funnel is absent.
- gateway auth blocks unauthenticated requests.
- rollback removes only manifest-owned files.
- rollback automatic actions are allowlisted to pai-anywhere config/state/app paths, service units, and the specific private Serve off command.
- secret grep passes on source, logs, state, and manifest.
- browser terminal bridge is implemented and reviewed, or public docs state Pulse-only support.
- at least two VPS providers and one mobile client pass the matrix.
