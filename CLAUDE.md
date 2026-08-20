# pai-anywhere

> Companion repo for Daniel Miessler's [Personal AI Infrastructure (PAI)](https://github.com/danielmiessler/Personal_AI_Infrastructure).
> Takes a fresh Linux VPS to a private, hardened, multi-device PAI host with a kid-simple setup path.

**Phase:** v0.2.4 (hybrid bash + slim TS). Release gated on `docs/VPS_TEST_RESULTS.md` matrix evidence (Hetzner CX22 Ubuntu 22.04/24.04, DigitalOcean Debian 12) + mobile pairing flow. Browser terminal bridge deferred to a later release. This file is the build-time briefing.

---

## Mission

PAI installs locally today. Users who want PAI reachable from laptop + desktop + mobile currently improvise: VPS provisioning, private networking, terminal access, Pulse access, notifications, migration checks, and hardening. pai-anywhere ships a packaged, paste-installable path that solves this without inventing a new PAI fork.

`pai-anywhere` ships the simple packaged path:

```bash
curl -fsSL https://pai-anywhere.dev/install | bash
pai-anywhere doctor
pai-anywhere verify
```

V1 thesis:

> One real PAI host. Many dumb clients. No `~/.claude` syncing. No public Pulse. No public PAI dashboard. Existing host config is sacred.

The default user experience is:

1. Paste one command on a fresh Ubuntu/Debian VPS.
2. Click the Tailscale login link.
3. Open one private tailnet URL from any device.
4. Use Terminal + Pulse through a private web doorway protected by a second app-level pairing code.

---

## Scope

### In scope

- VPS bootstrap on Ubuntu/Debian (bonus later: Fedora, Arch).
- Check-before-install for Bun, Git, Tailscale, fail2ban, and ufw.
- Private Tailscale web doorway via Tailscale Serve, never Funnel.
- A tiny localhost-only gateway that exposes:
  - `/terminal` to a controlled PAI host session.
  - `/pulse` to Pulse on `127.0.0.1:31337`.
- App-level pairing code/session cookie on top of tailnet access.
- Pulse as a host service, bound to loopback only.
- Dedicated PAI account/profile by default:
  - Existing `~/.claude` is not touched.
  - PAI runs as an unprivileged `pai` user.
  - PAI's managed profile is `/home/pai/.claude`.
- Optional Telegram text notifications for mobile.
- Migration verifier for the Discussion #617 "vanilla claude post-migration" trap.
- Read-only `doctor`, manifest-recorded changes, rollback, reset-access, uninstall. (`install --dry-run` deferred to a later release; the installer is idempotent bash with explicit phases.)
- Hardening checklist and threat model.
- OMC + oh-my-openagent coexistence notes for advanced non-isolated installs.
- Runtime adapter boundary for future OpenCode/OpenAgent support.

### Out of scope

- Hosting other people's PAI (single-tenant per Personal Use Boundary).
- Replacing PAI's `install.sh` or `PAI/PAI-Install/` TS installer.
- Public-facing PAI, public Pulse, public terminal, public dashboard, or Tailscale Funnel.
- Cloudflare Tunnel / browser SSH for V1.
- Dockerizing all of PAI for V1.
- Rewriting users' existing server config.
- Syncing or copying an existing `~/.claude` without explicit migration approval.
- Voice/audio routing in V1. It requires a separate design.
- Model/provider routing in V1. PAI-OpenCode and oh-my-openagent stay separate adapter layers.

---

## Hard Constraints

| Constraint | Rule |
|---|---|
| Stack | bun + TypeScript for project code. Bootstrap may be POSIX shell only to install/run Bun. No Python. |
| Access | Default access is Tailscale Serve private HTTPS only. Never Funnel. |
| Public surface | No public Pulse, public terminal, public dashboard, or public `~/.claude` exposure. |
| Existing config | Existing user `~/.claude` is sacred. Default install uses `/home/pai/.claude` under a dedicated account. |
| Server config | Additive only. Prefer owned drop-ins. Never rewrite host config wholesale. |
| Dependencies | Detect existing Bun/Git/Tailscale/fail2ban/ufw before installing or configuring. |
| Secrets | Never persist private repo URLs, OAuth tokens, Anthropic keys, Tailscale auth keys, or `~/.claude` contents in this repo or logs. |
| Composition | Calls upstream `install.sh`; does not fork or reimplement PAI's installer. |
| Pulse | Pulse binds to `127.0.0.1:31337` only. Gateway proxies it privately. |
| Browser terminal | Tailnet access is not enough. Require pairing code + signed session cookie. |
| Verification | Install cannot claim success until `verify` passes. |
| Reversibility | Every mutation is recorded in `/etc/pai-anywhere/install-manifest.jsonl` (append-only JSONL, written by `install.sh`); `uninstall.sh` reverses only manifest-recorded paths. |
| Runtime | V1 hosts canonical Claude Code PAI only. OpenCode/OpenAgent are future isolated adapters. |

---

## Safety Model

Default state after install:

```text
Internet
  -> no PAI HTTP ports
  -> SSH unchanged unless user explicitly chooses hardening

Tailnet
  -> https://<host>.<tailnet>.ts.net
      -> Tailscale Serve
          -> 127.0.0.1:<pai-anywhere-gateway>
              /terminal -> controlled host session
              /pulse    -> 127.0.0.1:31337

Host
  /home/<user>/.claude      existing user config, untouched
  /home/pai/.claude         managed PAI Claude profile
  /var/lib/pai-anywhere     pairing secrets, gateway state, backups
  /etc/pai-anywhere         config and install manifest
```

Host mutations must use owned files:

```text
/etc/systemd/system/pai-anywhere.service
/etc/systemd/system/pai-pulse.service
/etc/fail2ban/jail.d/pai-anywhere-sshd.local
/etc/ufw/applications.d/pai-anywhere
/etc/pai-anywhere/config.json
/etc/pai-anywhere/install-manifest.json
/var/lib/pai-anywhere/
```

Never rewrite these wholesale:

```text
/etc/ssh/sshd_config
/etc/ufw/ufw.conf
/etc/fail2ban/jail.local
~/.claude/settings.json
```

If SSH hardening is explicitly requested, use `/etc/ssh/sshd_config.d/99-pai-anywhere.conf`, validate with `sshd -t`, then reload.

---

## Composition Rule

PAI's default public install entrypoint:

```bash
curl -sSL https://ourpai.ai/install.sh | bash
```

That public bootstrap currently backs up/moves `~/.claude` and installs to `~/.claude`. `pai-anywhere` therefore must not run it as the invoking human user. V1 runs the official installer as the dedicated `pai` account so the upstream default path resolves to `/home/pai/.claude`.

`pai-anywhere install` orchestrates around that flow:

```text
1. Inspect       : read-only environment, dependency, port, firewall, Tailscale checks
2. Dry-run plan  : show exact packages, files, services, and commands before mutation
3. Dependencies : install only missing Bun/Git/Tailscale/fail2ban/ufw pieces
4. Tailscale     : start/login if needed; use private Serve only; never edit ACLs by default
5. Account       : create/use locked pai user; leave human ~/.claude untouched
6. PAI install   : invoke https://ourpai.ai/install.sh as pai, never as the human user
7. Access reset   : generate gateway pairing code + session secret
8. Systemd       : run Pulse and gateway as loopback-only services
9. Tailscale     : use private Serve only; never edit ACLs by default; never Funnel
10. Verify       : probe Algorithm, system prompt, hooks, Pulse, gateway, and exposure safety
```

The private repo URL rule is precise: the tool may accept a user-provided private repo URL at runtime if upstream install requires it, but it must never log, persist, telemetry-send, commit, or echo it.

---

## Architecture Sketch

```text
pai-anywhere/
├── install.sh                    # bash paste-installer (idempotent, manifest-recording)
├── uninstall.sh                  # reverses only manifest-recorded paths
├── CLAUDE.md                     # this file (build-time briefing)
├── README.md                     # community-facing
├── package.json
├── src/                          # TypeScript: gateway + doctor only
│   ├── cli.ts                    # gateway | doctor | verify | reset-access | help
│   ├── doctor/
│   │   ├── inspect.ts            # read-only host inspection
│   │   ├── probes.ts             # post-install verification probes
│   │   ├── report.ts             # CLI-formatted output
│   │   └── types.ts
│   ├── gateway/
│   │   ├── server.ts             # Bun.serve loopback gateway; /pulse proxy
│   │   ├── auth.ts               # pairing code + HMAC-signed cookie
│   │   ├── types.ts
│   │   └── *.test.ts             # unit + integration tests
│   └── lib/
│       └── paths.ts              # managed path resolution
├── docs/
│   ├── QUICKSTART.md             # Hetzner + DigitalOcean walkthroughs
│   ├── THREAT_MODEL.md
│   ├── HARDENING.md
│   ├── VPS_TEST_MATRIX.md
│   └── VPS_TEST_RESULTS.md
├── scripts/
│   ├── pin-installer.sh          # bumps PAI + Bun SHA-256 pins
│   ├── vps-smoke.sh              # VPS test runner
│   ├── vps-matrix-result.sh
│   └── collect-diagnostics.sh
└── tests/                        # bash regression scripts
    ├── preserve-claude.sh
    ├── sha256-mismatch.sh
    ├── manifest-completeness.sh
    ├── partial-install-rollback.sh
    ├── uninstall-safety.sh
    ├── pairing-code-leak.sh
    ├── log-format.sh
    └── container-install.sh
```

Install/rollback live in bash (install.sh, uninstall.sh) — TypeScript covers gateway + doctor only.

---

## Runtime Adapter Boundary

V1 is a secure host/access installer for canonical Claude Code PAI. It is not the model orchestration layer.

Keep this boundary:

```text
pai-anywhere
  -> private host setup
  -> isolated Claude profile
  -> Pulse/gateway/systemd/Tailscale
  -> security checks, verify, rollback

pai-opencode / oh-my-openagent
  -> provider/model routing
  -> OpenCode/OpenAgent config
  -> GPT/Gemini/Kimi/Claude/Copilot/etc.
  -> agent-specific model selection
```

Future support should be adapter-based and isolated:

```bash
pai-anywhere runtime list
pai-anywhere runtime add opencode
pai-anywhere runtime add openagent
pai-anywhere runtime switch claude
pai-anywhere runtime switch opencode
```

Each future runtime gets its own managed account/config root:

```text
/home/pai/.claude
/var/lib/pai-anywhere/runtimes/opencode
/var/lib/pai-anywhere/runtimes/openagent
```

No shared secrets. No touching existing `~/.claude` or `~/.config/opencode` by default. The gateway may eventually show separate runtime tabs, but V1 must stay focused on making canonical PAI secure and easy to host.

---

## Related PAI-Ecosystem Repos

| Repo | Role |
|---|---|
| `Personal_AI_Infrastructure/` | Canonical PAI. Read `Releases/v5.0.0/.claude/install.sh`, `PAI/PULSE/`, `.pai-protected.json`. |
| `oh-my-claudecode/` (OMC) | Claude Code orchestration layer. Relevant for advanced coexistence if user opts into existing `~/.claude`. |
| `oh-my-openagent/` (Sisyphus) | OpenAgent variant. Relevant for advanced coexistence docs. |
| `pai-opencode/` | OpenCode adapter for PAI. Reference for non-Claude-Code PAI usage. |
| `pai-review-mode/` | PAI review-flow specialization. |
| `specfirst-skill/` | Spec-first skill; source of ISC/ISA discipline. |

---

## Implementation Notes

- `install.sh` (bash, ~448 stripped LOC) is the user-facing entrypoint. Paste-installs on fresh Ubuntu/Debian VPS. Idempotent functions: preflight, install_apt_deps, install_tailscale_apt (signed apt repo, never `curl|sh`), create_pai_user, install_bun_for_pai (SHA-256 verified), fetch_and_verify_pai (SHA-256 verified, abort on mismatch), run_pai_as_pai, install_gateway_app, generate_secrets (20-char base64url pairing code, 0600), write_systemd_units, tailscale_up_if_needed, tailscale_serve_private (refuses Funnel; picks the tailnet HTTPS port), verify, print_done.
- Serve port selection is load-bearing, not cosmetic. `tailscale serve --https=<port>` makes tailscaled intercept peer traffic to the tailnet IP inside netstack, **before** any iptables/DNAT rule. Claiming a port another service already owns (Traefik/nginx/Caddy) black-holes that service for every tailnet client while it keeps answering on loopback and public interfaces — so `curl` from the host still returns 200 and nothing lands in the proxy's access log. `tailscale serve status` cannot see such a service; `host_port_in_use()` probes the host directly (ss → netstat → docker published ports). Default is auto: prefer 443, fall back to `PAI_ANYWHERE_SERVE_PORT_FALLBACK` (10000). `PAI_ANYWHERE_SERVE_PORT` pins a port and disables the fallback — an occupied pinned port aborts the install. Never re-introduce a bare `tailscale serve --bg <url>`: it silently defaults to 443.
- The live Serve port is read back from `tailscale serve status --json` (`serve_port_for_gateway()`), not assumed. `print_done` and `uninstall.sh` both depend on that lookup.
- `uninstall.sh` reads `/etc/pai-anywhere/install-manifest.jsonl` (intent-log JSONL written by `install.sh`'s `record()` helper) and reverses only manifest-recorded paths. ENOENT = skip. EACCES/symlink/owner-mismatch = abort. Unowned files inside target dirs are preserved.
- `src/cli.ts` (~130 LOC) ships only: `gateway`, `doctor`, `verify`, `reset-access`, `help`. No install/rollback subcommands — those live in bash.
- `src/gateway/` (~370 LOC) — Bun.serve loopback gateway. 20-char base64url pairing code (≥120 bits entropy). Per-source pairing rate limit (10 attempts / 15 min, `rate-limit.v2` buckets keyed by `Tailscale-User-Login` when identity binding is on, else the socket address; no XFF). Session cookie bound to the pairing client's tailnet identity (`PAI_ANYWHERE_REQUIRE_TAILNET_IDENTITY`, on by default). HMAC-signed session cookie. Proxies all paths to Pulse on `127.0.0.1:31337` (Pulse uses absolute `/_next/*`, `/agents`, `/telos` paths) with method allowlist (`GET`/`POST`/`HEAD`), 1MB body cap, and rejection of `/__gateway/*` + path-traversal. `/terminal` returns 410 with roadmap link. Refuses to start if `PAI_ANYWHERE_PAIRING_CODE` env unset.
- `src/doctor/` (~620 LOC, includes folded-in verify probes) — read-only host inspection + post-install probes.
- Hash pinning: `scripts/pin-installer.sh` + `.github/workflows/pin-bot.yml` (manual `workflow_dispatch` only — weekly cron was removed so pin bumps stay deliberate). PRs labeled `pin-bot` require `CODEOWNERS` review.
- Tests: `bun test` (gateway unit + integration), `tests/*.sh` (preserve-claude, sha256-mismatch, uninstall-safety, partial-install-rollback, manifest-completeness, pairing-code-leak, serve-port-conflict), `shellcheck -S warning` CI gate. `serve-port-conflict.sh` extracts the port helpers out of the real `install.sh`, so it fails if the implementation drifts.
- VPS test matrix evidence in `docs/VPS_TEST_RESULTS.md` (gated by Phase 6 manual run).

---

## Working Rules For This Repo

- Read this file + the actual `install.sh` before touching install behavior.
- Build `doctor` first; verify probes before changing install logic.
- `install.sh` is the entry point; phases run sequentially and stop on first failure (see `main()` at end).
- PAI bootstrap must run `https://ourpai.ai/install.sh` only as the dedicated `pai` user, never as the invoking human user.
- PAI bootstrap must refuse to run over an existing managed profile unless an explicit future reinstall flow is designed.
- Default install must not modify, move, delete, or rewrite the invoking user's `~/.claude`.
- Default install must run PAI as a dedicated unprivileged `pai` account with managed profile `/home/pai/.claude`.
- Never use Tailscale Funnel.
- Never claim a tailnet Serve port without probing the host first; a port another service owns is never taken silently.
- Never bind Pulse or the gateway to public interfaces.
- Never edit Tailscale ACLs automatically in V1.
- Never enable or tighten ufw unless SSH/current access safety is proven.
- Never rewrite existing service/config files that are not already recorded as pai-anywhere-owned.
- `/opt/pai-anywhere` is the default owned app bundle path for systemd; if it exists unowned, install must stop.
- Never rewrite host config wholesale; use owned drop-ins only.
- Never persist secrets or private repo URLs; redact logs.
- Never mount `~/.claude` into Docker or a container in V1.
- Never configure OpenCode/OpenAgent/model providers in V1.
- Every install mutation must be recorded in a manifest.
- Rollback/uninstall removes only `pai-anywhere`-owned artifacts.
- Verification is non-optional.
- VPS matrix evidence is non-optional before public release.
- `reset-access` must rotate both gateway pairing code and session secret; old cookies must stop working after gateway restart.

---

## References

- [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) — V1 threat model
- Upstream PAI public installer: `https://ourpai.ai/install.sh`
- Upstream PAI bundled installer: `Personal_AI_Infrastructure/Releases/v5.0.0/.claude/install.sh` (canonical PAI repo)
- Upstream Pulse: `Personal_AI_Infrastructure/Releases/v5.0.0/.claude/PAI/PULSE/`
- Upstream containment manifest: `Personal_AI_Infrastructure/.pai-protected.json`
- [Discussion #617 — Mirror PAI to another server](https://github.com/danielmiessler/Personal_AI_Infrastructure/discussions/617)
- [Discussion #922 — Install pain](https://github.com/danielmiessler/Personal_AI_Infrastructure/discussions/922)
- [Issue #25746 — Tailscale/IPN feature request, claude-code](https://github.com/anthropics/claude-code/issues/25746)
