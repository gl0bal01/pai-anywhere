# pai-anywhere Quickstart

Two paths from "no VPS yet" to "PAI Pulse on my phone." Pick whichever matches your provider.

Either way you need:
- A [Tailscale](https://tailscale.com) account (free tier fine)
- A credit card for the VPS

---

## Path A: Hetzner CX22 (~$4/mo)

1. **Create Hetzner account** at <https://www.hetzner.com/cloud>. Add SSH key under *Security → SSH Keys*.

2. **Create server**:
   - *Location:* nearest to you
   - *Image:* Ubuntu 24.04
   - *Type:* CX22 (2 vCPU, 4GB RAM, ~$4.51/mo)
   - *Networking:* Public IPv4 + IPv6 (default)
   - *SSH key:* select yours
   - Click **Create & Buy now**. ~30s to boot.

3. **SSH in** as root using the IP shown:
   ```bash
   ssh root@<vps-ip>
   ```

4. **Run installer**:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/gl0bal01/pai-anywhere/v0.1.1/install.sh | bash
   ```
   - When `tailscale up` prints a login URL, open it in a desktop browser logged into your Tailscale account. Click *Connect*.
   - Installer continues; ~3-5 minutes total.
   - End screen shows: tailnet URL (`https://<host>.<tailnet>.ts.net`) + 20-char pairing code.
   - Press enter once recorded.

5. **From your phone or laptop** (same tailnet):
   - Open the tailnet URL in a browser
   - Enter the pairing code
   - Land on PAI Pulse Life dashboard

If you lose the pairing code: `sudo pai-anywhere reset-access --yes` rotates it.

---

## Path B: DigitalOcean basic droplet (~$6/mo)

1. **Create DigitalOcean account** at <https://www.digitalocean.com>. Add SSH key under *Settings → Security*.

2. **Create droplet**:
   - *Region:* nearest to you
   - *Image:* Debian 12 x64
   - *Plan:* Basic → Regular → $6/mo (1 vCPU, 1GB RAM, 25GB SSD)
   - *Authentication:* SSH key (select yours)
   - Click **Create Droplet**. ~1 min to provision.

3. **SSH in**:
   ```bash
   ssh root@<droplet-ip>
   ```

4. **Run installer** — same one-liner:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/gl0bal01/pai-anywhere/v0.1.1/install.sh | bash
   ```
   Same flow as Hetzner.

5. **Use it** — open the tailnet URL on any device on your tailnet.

> **Note:** 1GB RAM is tight for Bun + Pulse + gateway under load. CX22 (4GB) feels smoother. Go with $6/mo only if budget rules.

---

## Cloud-init alternative (any provider with user-data field)

Paste this into the *User Data* box at server creation time:

```yaml
#cloud-config
package_update: true
runcmd:
  - curl -fsSL https://raw.githubusercontent.com/gl0bal01/pai-anywhere/v0.1.1/install.sh | bash
```

Server boots with installer running. Watch via `tail -f /var/log/cloud-init-output.log`. You still need to interactively `tailscale up` — SSH in and `journalctl -u tailscaled -f` to find the auth URL.

---

## Verify

After install, on the VPS:

```bash
sudo -u pai pai-anywhere doctor
sudo pai-anywhere verify
```

Both should report all checks pass.

If a check fails: see [THREAT_MODEL.md](./THREAT_MODEL.md) and [HARDENING.md](./HARDENING.md).

---

## Connect from Desktop / Laptop / Mobile

Goal: type `pai` from any device → same VPS, same memory, same auth.

### Desktop & Laptop (SSH alias)

The installer prints a copy-pasteable alias at the end. Add it to `~/.zshrc` (or `~/.bashrc`):

```bash
alias pai='ssh you@your-vps.tailnet.ts.net -t "sudo -iu pai -- pai"'
```

Reload your shell:

```bash
source ~/.zshrc
```

Now from anywhere:

```bash
pai
```

First time pai launches, run `/login` inside the REPL to authenticate Claude Code. Done once for the lifetime of the pai user.

### Mobile (browser + Tailscale SSH app)

- **Pulse dashboard:** install Tailscale (iOS/Android), open `https://<host>.<tailnet>.ts.net`, enter the pairing code.
- **REPL on phone:** Tailscale's mobile app has built-in SSH. Tap host → SSH → user `pai` → run `pai`.

### VPS itself

```bash
sudo -iu pai
pai
```

Or alias it on the VPS too: `echo "alias paime='sudo -iu pai'" >> ~/.zshrc`.

---

## Day 2 operations

| Task | Command |
|---|---|
| Rotate pairing code + invalidate sessions | `sudo pai-anywhere reset-access --yes` |
| Re-check health | `sudo pai-anywhere verify` |
| Tail Pulse logs | `sudo journalctl -u pai-pulse.service -f` |
| Tail gateway logs | `sudo journalctl -u pai-anywhere.service -f` |
| Restart gateway | `sudo systemctl restart pai-anywhere.service` |
| Uninstall completely | `sudo /opt/pai-anywhere/uninstall.sh` |
| Update PAI installer hash | open PR from `pin-bot` weekly cron |

---

## Cost summary

| Provider | Plan | Cost | Notes |
|---|---|---|---|
| Hetzner | CX22 | ~$4.51/mo | Best price/perf for v0.1 |
| DigitalOcean | Basic 1GB | $6.00/mo | Tighter RAM |
| Vultr | Cloud Compute 1GB | $6.00/mo | Untested in matrix |

Tailscale free tier supports 100 devices on the personal plan — fine for one PAI host + your phone + laptop + desktop.

---

## Troubleshooting

- **Pairing page won't load:** confirm Tailscale is up on both VPS and your client (`tailscale status`). Confirm `pai-anywhere.service` is active.
- **Pairing code rejected after multiple wrong attempts:** rate limit (10 attempts / 15 min). Wait or `sudo pai-anywhere reset-access --yes`.
- **Pulse shows blank page:** check `journalctl -u pai-pulse.service -n 50` for upstream Pulse errors. Gateway proxies all paths to Pulse on `127.0.0.1:31337`; if Pulse is down, the gateway returns 502.
- **`/terminal` returns 410:** expected. Browser terminal deferred to v0.2.
- **Install aborts with "sha256 mismatch":** upstream PAI installer changed; wait for `pin-bot` PR to bump the pinned hash, or run `scripts/pin-installer.sh` locally + audit upstream diff before continuing.
