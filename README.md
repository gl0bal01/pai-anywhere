# pai-anywhere

Private, hardened, multi-device hosting for Daniel Miessler's [Personal AI Infrastructure (PAI)](https://github.com/danielmiessler/Personal_AI_Infrastructure).

Paste one command on a fresh Ubuntu/Debian VPS, log in to Tailscale, open one private URL, enter a pairing code, use PAI Pulse from any device.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/gl0bal01/pai-anywhere/v0.1.0/install.sh | sudo bash
```

What happens:
1. Apt-installs deps; Tailscale via signed apt repo (never `curl|sh`).
2. Creates dedicated `pai` user. Your `~/.claude` is never touched.
3. Downloads PAI installer from `https://ourpai.ai/install.sh`, SHA-256 verifies against pinned hash, runs as `pai`. Profile lives at `/home/pai/.claude`.
4. Installs Bun for `pai` (SHA-256 verified by arch).
5. Drops two systemd services (loopback-only Pulse + gateway).
6. Generates 20-char pairing code, stores at `/var/lib/pai-anywhere/pairing-code.txt` (mode 0600).
7. `tailscale up` (interactive login link). `tailscale serve` private. Funnel is refused.
8. Runs `pai-anywhere doctor` self-check.

End state: visit `https://<your-host>.<tailnet>.ts.net` from any tailnet device, enter pairing code, land on PAI Pulse Life dashboard.

## Uninstall

```bash
sudo /opt/pai-anywhere/uninstall.sh
```

Reads `/etc/pai-anywhere/install-manifest.jsonl` and reverses only what `install.sh` recorded. Unowned files in target dirs are preserved.

## Rotate access

```bash
sudo pai-anywhere reset-access --yes
```

New pairing code, new session secret. Old browser cookies invalidated on service restart.

## Use PAI

The tailnet URL gives you the **Pulse dashboard** — observability over what PAI does. The chat REPL runs on the VPS itself; v0.1 does not expose a browser terminal (`/terminal` returns 410, deferred to v0.2).

To actually chat with PAI from your VPS:

```bash
ssh <your-user>@<vps>
sudo -iu pai            # become the dedicated pai account
source ~/.zshrc          # PAI installer added bun PATH here
pai                      # launches the REPL (Claude Code wrapper)
```

First-run setup (inside the REPL):

- Type `/interview` to walk through identity, projects, TELOS goals via guided wizard.
- Or `/exit` and edit files directly under `/home/pai/.claude/PAI/USER/`:
  - `USER/DA/README.md` — AI name, voice, personality
  - `USER/TELOS/README.md` — missions, goals, problems
  - `USER/PROJECTS/README.md` — project registry

PAI uses Claude Code, so the `pai` user needs an Anthropic API key OR a `claude` CLI auth session:

```bash
sudo -iu pai
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc
exec zsh
pai
```

### Mobile / remote shell access

`/terminal` is intentionally 410 in v0.1. For shell access from your phone, use Tailscale's official iOS/Android app — it has built-in SSH:

```
Tailscale iOS/Android → connect to tailnet → tap host → SSH → user: pai
```

Or from desktop: `tailscale ssh pai@<host>.<tailnet>.ts.net`.

### Pulse dashboard pages

Once paired, the tailnet URL lands on the Life dashboard. Other pages:

- `/` — Life dashboard (TELOS goals, missions)
- `/agents` — subagent activity log
- `/work` — work session history
- `/security` — bash/path security events
- `/finances`, `/health`, `/business`, `/air`, `/arbol`, `/assistant` — life domains
- `/api/*` — JSON endpoints (programmatic)

Pulse reads/writes data the `pai` REPL produces. Chat in the REPL → metrics show up in Pulse.

### Optional integrations

- **Voice (ElevenLabs TTS):** set `ELEVENLABS_API_KEY` in `/home/pai/.claude/PAI/USER/Config/`
- **Telegram notifications:** set `TELEGRAM_BOT_TOKEN`. See upstream PAI docs.

## What v0.1 ships

- One paste-install command for Ubuntu 22.04+, Debian 12+
- Pulse over private Tailscale Serve
- HMAC-signed session cookie + base64url pairing code (≥120 bits entropy)
- Loopback-only services; never public
- Hash-pinned upstream (PAI installer, Bun)
- Manifest-recorded, reversible install
- Read-only `doctor` health check

## What v0.1 does not ship

- Browser terminal (`/terminal` returns 410 with roadmap link; v0.2)
- Fedora / Arch (v0.3)
- Telegram notifications
- Multi-tenant
- Public Pulse, public terminal, Tailscale Funnel — forbidden

## Documentation

- [docs/QUICKSTART.md](./docs/QUICKSTART.md) — Hetzner $4/mo + DigitalOcean $6/mo walkthroughs
- [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) — V1 threat model
- [docs/HARDENING.md](./docs/HARDENING.md) — operator hardening notes
- [CLAUDE.md](./CLAUDE.md) — build-time architecture brief

## Project status

Pre-release. Release gated on `docs/VPS_TEST_RESULTS.md` evidence (Hetzner CX22 Ubuntu 22.04/24.04, DigitalOcean Debian 12).

## License

See upstream PAI for licensing of bundled installer.
