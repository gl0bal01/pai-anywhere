# pai-anywhere

> One PAI on a VPS. Type `pai` from any device. Same memory, same context, every time.

Hardened, paste-installable host for Daniel Miessler's [Personal AI Infrastructure](https://github.com/danielmiessler/Personal_AI_Infrastructure) on a Linux VPS.

---

## How it works

```
                                Tailnet (private VPN)
                                        │
   ┌──────────┐                         │                   ┌─────────────────────┐
   │ Desktop  │  ssh -t sudo -iu pai ──►├─────────────────► │  VPS (Ubuntu/Debian)│
   │ alias pai│                         │                   │                     │
   └──────────┘                         │                   │   pai user (locked) │
                                        │                   │   ~/.claude/PAI/    │
   ┌──────────┐                         │                   │                     │
   │ Laptop   │  ssh -t sudo -iu pai ──►│                   │   Pulse :31337      │
   │ alias pai│                         │                   │   Gateway (HMAC)    │
   └──────────┘                         │                   │                     │
                                        │                   │   /home/pai/        │
   ┌──────────┐                         │                   │   (sandboxed)       │
   │ Mobile   │  https://host.tailnet ──►                   │                     │
   │ browser  │  + pairing code            ◄─Tailscale Serve│                     │
   └──────────┘                                             └─────────────────────┘
                                        │
                                        │
                                        ▼
                              Anthropic / Claude Code
```

- **One install** on the VPS. Clients are SSH aliases — zero state on Desktop/Laptop.
- **Same memory + auth + billing.** PAI lives at `/home/pai/.claude/`, never touched by clients.
- **Pulse dashboard** for mobile via Tailscale Serve (HTTPS + pairing code).
- **Your existing `~/.claude` is sacred.** pai-anywhere never reads or writes it.

---

## Quickstart (5 steps)

### 1. Get a fresh Linux VPS

Ubuntu 22.04+, Debian 12+. $4–6/mo at Hetzner/DigitalOcean is enough. SSH in as a sudo-capable user.

### 2. Install pai-anywhere

On the VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/gl0bal01/pai-anywhere/v0.2.4/install.sh | sudo bash
```

The installer prints a Tailscale login link — click it, authenticate. At the end it shows:
- Your private URL (`https://<host>.<tailnet>.ts.net`, with a port appended if the host already runs something on 443 — see [docs/TAILNET_ACCESS.md](./docs/TAILNET_ACCESS.md))
- A 20-character pairing code
- An SSH alias to copy

### 3. Add the alias on Desktop & Laptop

Copy the printed alias into `~/.zshrc` or `~/.bashrc` on each client:

```bash
alias pai='ssh you@your-vps.tailnet.ts.net -t "sudo -iu pai -- pai"'
```

Reload: `source ~/.zshrc`.

### 4. Open Pulse on mobile (optional)

Install Tailscale on your phone, open the printed URL in Safari/Chrome, enter the pairing code.

### 5. Use it

```bash
pai          # from anywhere — Desktop, Laptop, or VPS
```

First launch: type `/login` to authenticate Claude Code (one time, in pai's account).

Then `/interview` to set up your identity, goals, projects in one wizard.

---

## Daily use

```bash
pai                          # start REPL
> read my notes from today
> review project X
> /memory                    # what does PAI remember about you
> /exit
```

Pulse on mobile (`https://<host>.<tailnet>.ts.net`) shows what PAI did, when, and why.

---

## Security model

| Layer | Protection |
|---|---|
| Network | Tailscale (private VPN). No public ports. Funnel forbidden. Restrict tailnet reach with [grants](./docs/TAILNET_ACCESS.md). |
| SSH | Standard SSH key auth. Tailscale ACLs limit who connects. |
| User | Dedicated `pai` system user. Password locked. Cannot login. |
| Filesystem | Pulse + Gateway run with systemd `ProtectHome=read-only`. |
| Pulse | Bound to `127.0.0.1:31337`. Never directly internet-exposed. |
| Gateway | HMAC-signed cookies + 20-char base64url pairing code (≥120 bits entropy). Session cookie bound to the pairing client's tailnet identity; per-source pairing rate limit (10/15min). |
| Secrets | Pairing code stored mode 0600. Never logged. |
| Install | Every change recorded in `/etc/pai-anywhere/install-manifest.jsonl`. Reversible. |
| Upstream | PAI installer + Bun pinned by SHA-256. Mismatch = abort. Pin bumps are manual pin-bot dispatch + CODEOWNERS review. |
| Backups | Optional age-encrypted daily snapshots (see [extras/backup/](./extras/backup/)). Operator-supplied; not auto-installed. Live secrets excluded; `reset-access` required post-restore. |

---

## Operator commands

```bash
sudo pai-anywhere doctor          # health check
sudo pai-anywhere reset-access    # rotate pairing code + session secret
sudo pai-anywhere help            # all commands
sudo /opt/pai-anywhere/uninstall.sh  # reverses only what install recorded
```

---

## FAQ

**Q: Why a dedicated `pai` system user?**
Isolation. Upstream PAI's installer rewrites `~/.claude/` — running it as `pai` (not you) means your existing Claude Code, OMC, opencode, or other tools are untouched. The promise "your `~/.claude` is sacred" is enforced by Linux user boundaries, not policy.

**Q: My VPS is also my dev box. How does pai see my code?**
Grant pai read access on specific dirs only:
```bash
sudo setfacl -R -m u:pai:rX /home/you/projects
sudo setfacl -dR -m u:pai:rX /home/you/projects
```
For write access (pai modifies your code): use `rwX` instead of `rX`. Don't grant on `~`.

**Q: Mobile shell access?**
Use Tailscale's iOS/Android app — it has built-in SSH. Tap host → SSH → user `pai`.

**Q: I want a browser terminal.**
Not shipped yet (`/terminal` returns 410) — secure browser-PTY is non-trivial, so it's deferred to a later release. Tailscale SSH handles 95% of cases.

**Q: Can I install on Fedora/Arch?**
Not yet — Ubuntu 22.04+ / Debian 12+ only. Fedora/Arch are planned.

**Q: Voice / Telegram?**
Optional, opt-in. Set env vars in `/home/pai/.claude/PAI/USER/Config/` after install. See upstream PAI docs.

**Q: Can multiple users share one VPS?**
Single-tenant by design (Personal Use Boundary). Multi-tenant is out of scope — a different threat model.

**Q: What if upstream PAI updates?**
Re-run the installer. SHA-256 pin gets bumped via `pin-bot` weekly. Manifest tracks all changes for clean rollback.

**Q: How do I back up `~pai/.claude` and the gateway state?**
Optional opt-in: see [`extras/backup/`](./extras/backup/) for an age-encrypted daily snapshot script + systemd timer + setup walkthrough. The installer does not deploy it; backup choices are opinionated (encryption, retention, off-site shape) so the operator owns them.

---

## What ships today

✅ Paste-install on Ubuntu 22.04+ / Debian 12+
✅ SSH alias generator for client devices
✅ Pulse dashboard via private Tailscale Serve
✅ HMAC + pairing code gateway
✅ SHA-256 pinned upstream
✅ Manifest-recorded, fully reversible install
✅ Read-only `doctor` self-check

❌ Browser terminal (deferred)
❌ Fedora / Arch (planned)
❌ Multi-tenant
❌ Public Pulse / Funnel (forbidden by design)

---

## Docs

- [QUICKSTART](./docs/QUICKSTART.md) — Hetzner $4 + DigitalOcean $6 walkthroughs
- [THREAT_MODEL](./docs/THREAT_MODEL.md) — what we defend against
- [HARDENING](./docs/HARDENING.md) — operator hardening notes
- [TAILNET_ACCESS](./docs/TAILNET_ACCESS.md) — restrict who on the tailnet can reach the gateway
- [extras/backup/](./extras/backup/) — opt-in encrypted daily backup script + systemd timer (operator-installed)
- [CLAUDE.md](./CLAUDE.md) — internal architecture brief

## Development

```bash
make check
```

That installs locked Bun dependencies, typechecks, runs Bun tests, shellchecks the shell entrypoints, and runs the non-root shell safety tests. Full VPS/container install smoke tests are explicit:

```bash
make test-install-container IMAGE=ubuntu:24.04
```

## License

MIT. Upstream PAI has its own license — see their repo.
