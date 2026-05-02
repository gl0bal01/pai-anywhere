# pai-anywhere Disposable VPS Test Matrix

This matrix is the release gate for the installer. It is intentionally manual around VPS creation and Tailscale login so the test works on any provider and does not require cloud credentials.

## Production Rule

Do not call pai-anywhere production-ready until every required row below is complete on disposable infrastructure.

Required:

- Provider A: fresh Ubuntu LTS VPS.
- Provider B: fresh Debian stable or Ubuntu LTS VPS.
- One laptop client on the same tailnet.
- One mobile client on the same tailnet.
- One install, reboot, verify, reset-access, and rollback cycle.

Nice to have:

- VPS with an existing human `~/.claude` directory before install.
- VPS where Bun already exists for the test user.
- VPS where Tailscale already exists but is logged out.

## Safety Rules

- Use a disposable VPS. Do not run this first on a valuable server.
- Do not paste API keys, OAuth tokens, private repo URLs, Tailscale auth keys, or Claude config contents into issue comments or logs.
- Do not enable Tailscale Funnel.
- Do not open public HTTP ports for Pulse, gateway, or terminal.
- Do not delete `/home/pai/.claude` during rollback unless you have explicitly backed up and reviewed it.
- Treat the generated `pai-anywhere-test-*` directory as sensitive until reviewed.

## Matrix

The matrix status is mirrored in [VPS_TEST_RESULTS.md](./VPS_TEST_RESULTS.md). Use `scripts/vps-matrix-result.sh` to generate auditable result blocks from smoke output directories.

| ID | Provider | OS | Existing `~/.claude` | Expected Result | Status | Evidence |
|---|---|---|---|---|---|---|
| VPS-A | Provider A | Ubuntu LTS | yes | install, verify, reboot verify, mobile access, rollback | pending | |
| VPS-B | Provider B | Debian stable or Ubuntu LTS | no | install, verify, reboot verify, mobile access, rollback | pending | |

## Fresh VPS Setup

On the disposable VPS:

```bash
sudo apt-get update
sudo apt-get install -y curl git ca-certificates
```

Clone or copy this repo onto the VPS, then install project dependencies:

```bash
cd pai-anywhere
bun install
```

If Bun is not installed yet, use the current project bootstrap path you are testing. Do not use a private token in the command line unless the test explicitly covers secret redaction.

## Test Flow

### 1. Baseline

Run:

```bash
scripts/vps-smoke.sh
```

Expected:

- `doctor` runs.
- `install --dry-run` runs.
- `verify` fails closed because PAI is not installed yet.
- No `/etc/pai-anywhere`, `/var/lib/pai-anywhere`, or `pai` account is created by baseline checks.

### 2. Install

Run:

```bash
scripts/vps-smoke.sh --apply
```

Expected:

- Installer stops on first failure or completes with `verify`.
- Official PAI bootstrap runs as the dedicated `pai` user, not the human user.
- The human user's `~/.claude` remains unchanged.
- Gateway pairing code is printed only in the terminal output from `reset-access`, not stored in the manifest.

Manual step:

- If Tailscale prints a login URL, open it and approve the disposable VPS.
- Rerun `scripts/vps-smoke.sh --apply` after login if the phase stopped there.

### 3. Tailnet Browser Check

From a laptop on the same tailnet:

1. Open the Tailscale Serve URL for the VPS.
2. Confirm `/` shows the pai-anywhere pairing page.
3. Enter the pairing code printed during install.
4. Confirm `/pulse/` loads or returns a Pulse-specific upstream response through the gateway.
5. Confirm `/terminal` returns a pending/not-implemented response in V1.

From a mobile device on the same tailnet:

1. Open the same private URL.
2. Pair with a fresh code after `reset-access --yes`.
3. Confirm the page is reachable only through Tailscale, not through the public VPS IP.

### 4. Reboot

Run:

```bash
sudo reboot
```

Reconnect, then:

```bash
cd pai-anywhere
scripts/vps-smoke.sh --post-reboot
```

Expected:

- `pai-pulse.service` is active.
- `pai-anywhere.service` is active.
- Pulse listens only on loopback.
- Gateway listens only on loopback.
- Tailscale Serve remains configured without Funnel.
- `pai-anywhere verify` passes, except for known V1 `/terminal` limitation if the probe is later added.

### 5. Access Reset

Run:

```bash
sudo bun run src/cli.ts reset-access --yes
```

Expected:

- New pairing code is generated.
- Old browser session no longer works after service restart.
- New pairing code works.
- Manifest does not contain the pairing code or session secret.

### 6. Rollback

Run:

```bash
scripts/vps-smoke.sh --rollback
```

Expected:

- Only manifest-owned pai-anywhere artifacts are removed.
- Existing human `~/.claude` remains unchanged.
- Managed PAI data under `/home/pai/.claude` is not automatically deleted.
- Missing manifest after rollback is a no-op.

## Evidence To Keep

Keep the output directory printed by `scripts/vps-smoke.sh`. Attach only reviewed and redacted files.

Minimum evidence:

- `summary.txt`
- `doctor.log`
- `plan.log`
- `verify-after-install.log`
- `verify-after-reboot.log`
- `rollback-plan.log`
- `diagnostics.txt`
- Human `~/.claude` before/after hash summary.

Do not share:

- Pairing codes.
- Cookie values.
- OAuth tokens.
- API keys.
- Private repo URLs.
- Raw Claude profile contents.

## Pass Criteria

All required VPS rows pass when:

- Install completes without public exposure.
- Reboot preserves services.
- Laptop and mobile reach the private gateway through Tailscale Serve.
- Unauthenticated `/pulse` access is blocked.
- Tailscale Funnel is absent.
- Existing human `~/.claude` is unchanged.
- Rollback removes only manifest-owned pai-anywhere artifacts.
- Diagnostics contain no obvious secrets after redaction.
