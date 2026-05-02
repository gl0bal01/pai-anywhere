# pai-anywhere: Strip to Community Installer (v0.1)

**Date:** 2026-05-02
**Mode:** consensus (RALPLAN-DR deliberate)
**Target LOC:** ~700 TS + ~470 bash (from 5238 TS)
**Working dir:** `/home/dev/projects/pai-projet/pai-anywhere`
**Plan revision:** 2 (post-Architect+Critic round 1)

---

## Requirements Summary

Reframe pai-anywhere from 5238-LOC TypeScript installer DSL to community-purpose hybrid distribution: ~300-line bash `install.sh` + ~250-LOC TS gateway + ~150-LOC TS doctor (verify folded in). Default user paste-installs on fresh Ubuntu/Debian VPS via `curl … | bash`, lands on private Tailscale-Serve URL, enters pairing code, uses Pulse from any device. Threat model preserved. Security gaps in current gateway fixed. Reversibility constraint preserved via bash-written JSONL manifest.

### Non-goals (v0.1)
- Browser terminal bridge (defer to v0.2)
- Fedora/Arch (defer to v0.3)
- Ansible playbook (defer to v0.3)
- Multi-tenant
- Docker
- Telegram notifications
- Observability/metrics/tracing (single-tenant home VPS, not needed)
- `install.sh` cryptographic signature (defer to v0.2; rely on github TLS + tag-pinned URL for v0.1)

---

## Principles (5)

1. **Threat model is the contract.** Every decision must trace to `docs/THREAT_MODEL.md` or `CLAUDE.md` Hard Constraints.
2. **Smaller surface = more eyes.** Community-purpose code lives or dies on auditability.
3. **Default path = no decisions.** One paste, no flags, no prompts mid-install.
4. **Preserve user `~/.claude` byte-for-byte by default.** Sacred.
5. **Pin upstream trust explicitly.** SHA-256 verify, signed apt repos, no blind `curl|sh`.

## Decision Drivers (top 3)

1. Distribution success — paste-install works on fresh Ubuntu/Debian VPS in <5 min.
2. Security gap closure — XFF rate-limit bypass + 6-digit code + curl|sh upstream are the ship-blockers.
3. LOC discipline — 5238 LOC overstates capability and blocks community contribution; target ~700.

## Alternatives Considered

### Option A — Hybrid bash + slim TS (CHOSEN)
**Approach:** ~300 LOC `install.sh` for system mutations; ~600 LOC TS for gateway, doctor, cli only.
**Pros:** Bash matches community VPS-tutorial mental model. TS retains for HMAC/proxy logic that bash can't do cleanly. shellcheck + bun test give two-pronged CI. One install URL, no UX branching.
**Cons:** Two languages. Bash idempotency requires care. Shell-quoting risk at boundaries.

### Option B — Pure bash + Caddy/nginx for gateway (REJECTED)
**Approach:** Bash install + Caddy reverse proxy with basic_auth + cookie session via Lua/templates.
**Why rejected:** HMAC-signed cookies + path/method allowlist + base32 pairing form needs scripting layer Caddy can't do natively. Adds web-server dependency vs single Bun process. Loses programmable allowlist. Total LOC similar but auditability worse (Caddy config + Lua + bash = 3 languages, 1 native runtime).

### Option C — Keep TS-only, refactor in place (REJECTED)
**Approach:** Stay 100% TS. Fix only the security bugs. Refactor duplicate phase scaffolding.
**Why rejected:** Doesn't address Driver 3 (LOC budget) or Driver 1 (community contribution friction). `lib/command.ts:53` already shells out, so "TS purity" was illusory. Bash-equivalent operations like `useradd`/`apt-get install`/`systemctl enable` in spawnSync TS are wasteful translation. After the dependency-on-shell admission, hybrid is just honest.

### Option D — Bash-JSONL audit manifest synthesis (ACCEPTED INTO OPTION A)
Architect surfaced this. `install.sh` writes append-only `/etc/pai-anywhere/install-manifest.jsonl` (one line per mutation: `{"ts":"…","kind":"…","path":"…","action":"…"}`). `uninstall.sh` reads it and reverses. ~30 LOC bash. Restores `CLAUDE.md` Hard Constraint "Reversibility: Every mutation is recorded." TS doctor reads same file for verification (no separate read library — bash format simple enough for `jq` on the doctor side too).

---

## Acceptance Criteria

| # | Criterion | Verification command |
|---|---|---|
| AC-1 | Single bash command on fresh Ubuntu 22.04/24.04 VPS produces working PAI host | Hetzner CX22 manual run, end-to-end, evidence in `docs/VPS_TEST_RESULTS.md` |
| AC-2 | `install.sh` ≤ 350 SLOC (stripped: comments + heredoc bodies excluded) | `cloc --exclude-list-file=cloc-exclude install.sh` reports ≤350 |
| AC-3 | TS source ≤ 600 SLOC across `gateway/` + `doctor/` + `cli.ts` + `lib/` | `cloc --exclude-ext=test.ts src/` ≤600 |
| AC-4 | Pairing code ≥ 60 bits entropy via `randomBytes(15).toString("base64url")` (20 chars URL-safe) | `bun test src/gateway/auth.test.ts` |
| AC-5 | Rate limit uses single global bucket (with optional `Tailscale-User-Login` header upgrade); never reads `X-Forwarded-For` from request | `bun test` + `grep -n "x-forwarded-for" src/gateway/` empty |
| AC-6 | `install.sh` SHA-256-verifies upstream PAI installer + Bun tarball before exec; mismatch → abort with non-zero exit | `tests/sha256-mismatch.sh` returns non-zero, no useradd, no /opt mutation |
| AC-7 | Tailscale installed via signed apt repo (`pkgs.tailscale.com`), not `curl … \| sh` | `grep -n "tailscale.com/install.sh" install.sh` empty; `apt-key fingerprint` includes documented Tailscale key |
| AC-8 | Pulse proxy enforces method allowlist (`GET`, `POST`, `HEAD`) and path allowlist (default `/`, `/healthz`, `/api/pulse/`); rejects others | `bun test src/gateway/server.test.ts` covers all 4 cases |
| AC-9 | `/terminal` returns 410 with JSON `{status:"deferred",roadmap:"<url>"}`, not 501 | `bun test` + `curl localhost:8787/terminal` |
| AC-10 | Existing `~/.claude` is byte-identical before/after install | `tests/preserve-claude.sh` runs in podman/docker container with seeded `~/.claude` |
| AC-11 | `uninstall.sh` reads `/etc/pai-anywhere/install-manifest.jsonl` and removes only manifest-recorded paths. Path semantics: ENOENT → "already clean" (skip, no error); EACCES or owner-mismatch or symlink-where-file-expected → abort with manual-review message; unowned paths inside target dirs → preserved | `tests/uninstall-safety.sh` |
| AC-12 | `docs/QUICKSTART.md` ≤ 1 page, includes Hetzner $4/mo + DO $6/mo walkthroughs with screenshots, install command uses `https://raw.githubusercontent.com/<org>/pai-anywhere/v0.1.0/install.sh` | docs review |
| AC-13 | `bun test` exits 0 covering: pairing brute-force resistance, cookie HMAC tampering, cookie expiry, pulse path/method allowlist, body cap, `/terminal` 410, code entropy | `bun test` |
| AC-14 | `docs/THREAT_MODEL.md` "Implementation Mapping" updated; each threat row references `install.sh:<line-range>` or `gateway/server.ts:<fn>` | docs review |
| AC-15 | No legacy schema-versioned types remain in source. Allowlisted on-disk schemas (`pai-anywhere.gateway-secrets.v1`, `pai-anywhere.session.v1`, `pai-anywhere.install-manifest.v1`) survive | `grep -rE "pai-anywhere\.(install-plan\|install-execution\|rollback-plan\|rollback-apply\|reset-access\|full-install\|doctor\|verify)\.v[0-9]" src/` empty |
| AC-16 | These dirs do not exist after strip: `src/install/`, `src/rollback/`, `src/access/`, `src/lib/manifest.ts`, `src/lib/redaction.ts`, `src/lib/command.ts`, `src/lib/listeners.ts`, `src/verify/` (folded into doctor) | `find src \( -path 'src/install' -o -path 'src/rollback' -o -path 'src/access' -o -path 'src/verify' -o -name 'manifest.ts' -o -name 'redaction.ts' -o -name 'command.ts' -o -name 'listeners.ts' \)` empty |
| AC-17 | No Telegram code/config/docs in v0.1 tree | `! grep -ri "telegram" src/ docs/ install.sh` |
| AC-18 | `gap.md` deleted; `CLAUDE.md` updated: drop ISC backlog table; add "v0.1 ships hybrid bash+TS" preamble | `[ ! -f gap.md ]` and `! grep "ISC-" CLAUDE.md` |
| AC-19 | `shellcheck -S warning install.sh uninstall.sh scripts/*.sh` exits 0 in CI | GitHub Actions `shellcheck` job |
| AC-20 | Reversibility preserved: `install.sh` writes JSONL audit manifest at `/etc/pai-anywhere/install-manifest.jsonl`; every pai-anywhere-owned mutation produces exactly one line. Test scope is **manifest-anchored prefixes only** (`/etc/pai-anywhere`, `/var/lib/pai-anywhere`, `/opt/pai-anywhere`, `/etc/systemd/system/pai-*.service`, `/home/pai`); apt/dpkg/systemd transitive side-effects (e.g., `/var/lib/dpkg/*`, target.wants symlinks) are excluded | `tests/manifest-completeness.sh` re-runs install in container, computes symmetric diff: (filesystem-newer in scoped prefixes) ⊕ (manifest-recorded paths) — empty diff = pass |
| AC-21 | Pairing code never persists in any logfile; only printed once via clear-screen banner; written to `/var/lib/pai-anywhere/pairing-code.txt` (mode 0600, owned by `pai`) for re-display via `cat` | `tests/pairing-code-leak.sh`: install with `\| tee log.txt`, `grep <code> log.txt` empty |

---

## Implementation Steps

### Phase 0: Capture state (1h)

1. Tag current main as `v0-pre-strip`
2. Snapshot `find src -name '*.ts' \| xargs wc -l > .omc/research/strip-baseline.txt`
3. Confirm `docs/THREAT_MODEL.md` is canonical security spec
4. Update `CLAUDE.md` "Reversibility" Hard Constraint row to: "Every mutation recorded in `/etc/pai-anywhere/install-manifest.jsonl` (bash-written, one line per mutation, append-only)" — preserves principle, names the new mechanism

### Phase 1: Write `install.sh` (1.5 days — adjusted from 1d for idempotency rigor)

Create `/home/dev/projects/pai-projet/pai-anywhere/install.sh` ~350 SLOC:

```bash
#!/usr/bin/env bash
set -euo pipefail

# ----- pinned constants -----
PAI_INSTALLER_URL="https://ourpai.ai/install.sh"
PAI_INSTALLER_SHA256="<pinned>"        # bumped via scripts/pin-installer.sh
BUN_VERSION="1.3.13"
BUN_SHA256_X86_64="<pinned>"
BUN_SHA256_ARM64="<pinned>"
GATEWAY_PORT="${PAI_ANYWHERE_GATEWAY_PORT:-8787}"
PAI_USER="pai"
APP_DIR="/opt/pai-anywhere"
CFG_DIR="/etc/pai-anywhere"
STATE_DIR="/var/lib/pai-anywhere"
MANIFEST="$CFG_DIR/install-manifest.jsonl"
VERSION_FILE="$CFG_DIR/VERSION"
VERSION="0.1.0"

# ----- audit primitive -----
record() {  # $1=kind $2=path $3=action
  printf '{"ts":"%s","kind":"%s","path":"%s","action":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$1" "$2" "$3" >> "$MANIFEST"
}

# ----- functions, each idempotent -----
preflight        # ubuntu/debian, root, refuse if VERSION_FILE missing AND $APP_DIR exists
install_apt_deps # curl ca-certificates gnupg fail2ban ufw git rsync jq
install_tailscale_apt  # signed repo: keyring 0o644, sources.list, apt install
create_pai_user  # idempotent: id -u pai || useradd ...; passwd -l
install_bun_for_pai  # download tarball, verify SHA256 by arch, runuser install
fetch_and_verify_pai # curl + sha256sum -c; abort on mismatch
run_pai_as_pai   # runuser -u pai -- env HOME=/home/pai bash <verified-installer>
install_gateway_app  # rsync src bundle to /opt/pai-anywhere
generate_secrets # 20-char base32 pairing + 32B session secret, mode 0600, owned pai
write_systemd_units  # heredoc 2 unit files, daemon-reload (each path → record)
tailscale_up_if_needed  # interactive login link if BackendState != Running
tailscale_serve_private # refuse if Funnel detected
verify           # call /opt/pai-anywhere/bin/pai-anywhere doctor; fail on red
print_done       # clear screen, banner with tailnet URL + pairing code, instruct reset-access if scrollback compromised

main()  # invoke functions in order; trap ERR → roll back via uninstall.sh; trap EXIT → ensure pairing code reminder
```

**Files to create:**
- `install.sh` (~350 SLOC, includes idempotency `if-not-already-X` gates per function)
- `uninstall.sh` (~80 LOC) — reads `$MANIFEST`, reverses each entry; refuses if any path is symlink, missing, or has changed owner; idempotent
- `scripts/pin-installer.sh` (~40 LOC) — fetches upstream installer + Bun tarballs, prints SHA-256s, replaces in `install.sh`
- `.github/workflows/shellcheck.yml` — block PRs on `shellcheck -S warning`
- `.github/workflows/pin-bot.yml` — weekly `scripts/pin-installer.sh` cron, opens PR on hash change

### Phase 2: Slim TypeScript surface (1.5 days)

**Phase 2a — gut callers in dependency order before deletion:**
1. `ripgrep -l 'from.*lib/manifest'` → list files importing manifest.ts
2. For each: replace import with `// removed in v0.1` + delete the call
3. Same for `lib/command`, `lib/redaction`, `lib/listeners`, `install/*`, `rollback/*`, `access/*`
4. Run `bunx tsc --noEmit` after each gutting → expect new errors only in to-be-deleted files

**Phase 2b — delete files:**
- `src/install/` (entire dir): `foundation.ts`, `dependencies.ts`, `pai-bootstrap.ts`, `systemd-apply.ts`, `tailscale.ts`, `plan.ts`, `report.ts`, `execution-report.ts`, `execution-types.ts`, `types.ts`, `systemd.ts` (~2900 LOC)
- `src/rollback/` (~440 LOC)
- `src/access/` (~366 LOC)
- `src/lib/manifest.ts` (132 LOC)
- `src/lib/listeners.ts` (43 LOC)
- `src/lib/redaction.ts` (27 LOC)
- `src/lib/command.ts` (69 LOC)
- `src/verify/` (entire dir, fold into doctor — see 2c)

**Phase 2c — fold `verify/` into `doctor/`:**
- Move probes from `src/verify/probes.ts` into new `src/doctor/probes.ts` (post-install probe set)
- `src/doctor/inspect.ts` becomes pre-install/health probe set
- Single `src/doctor/report.ts` formats both
- Single `src/doctor/types.ts` shared shapes

**Phase 2d — refactor remaining:**
- `src/cli.ts` → ~80 LOC: `gateway`, `doctor`, `verify` (calls `doctor --post-install`), `reset-access`, `help`
- `src/gateway/server.ts` → ~200 LOC (security fixes Phase 3)
- `src/gateway/auth.ts` → ~120 LOC (entropy + global rate limit)
- `src/gateway/types.ts` → ~25 LOC
- `src/doctor/inspect.ts` → ~150 LOC (drop secret-leak filesystem scan; keep listener parsing inline)
- `src/doctor/probes.ts` → ~200 LOC (read manifest JSONL via `fs.readFileSync` + line split)
- `src/doctor/report.ts` → ~50 LOC
- `src/doctor/types.ts` → ~25 LOC
- `src/lib/paths.ts` → ~30 LOC

### Phase 3: Fix gateway security (0.5 day)

**`src/gateway/auth.ts`:**

1. **Pairing code:** `randomBytes(15).toString("base64url")` → 20 chars, 120 bits. Form regex: `[A-Za-z0-9_-]{12,32}`.
2. **Rate limit (chosen for v0.1):** **single global bucket only**. Drop `pairingAttemptKey` entirely; bucket key is a constant. 10 attempts per 15-min sliding window. Document choice in code comment: `// v0.1: single-tenant home VPS; global bucket. Tailscale-User-Login per-user upgrade deferred to v0.2.`
3. Drop `x-forwarded-for` and `x-real-ip` reads completely.

**`src/gateway/server.ts`:**

4. **Pulse path/method allowlist** in `proxyPulse`:
   ```ts
   const ALLOWED_METHODS = new Set(["GET", "POST", "HEAD"]);
   const ALLOWED_PULSE_PATHS = ["/", "/healthz", "/api/pulse/"];
   if (!ALLOWED_METHODS.has(request.method))
     return json({error:"method not allowed"}, {status:405});
   const matched = ALLOWED_PULSE_PATHS.some(p =>
     suffix === p || (p.endsWith("/") && suffix.startsWith(p)));
   if (!matched) return json({error:"not found"}, {status:404});
   ```
5. **Body cap:** `Content-Length > 1_048_576` → 413.
6. **`/terminal`:** 410 + JSON `{status:"deferred",roadmap:"https://github.com/<org>/pai-anywhere/issues/1-terminal-bridge"}`.
7. **Refuse start without pairing-code env:** `gatewayConfigFromArgs` throws if `PAI_ANYWHERE_PAIRING_CODE` unset. install.sh always provides it. No more in-process random fallback.

### Phase 4: Pin upstream hashes (0.5 day)

8. `scripts/pin-installer.sh`: fetch `https://ourpai.ai/install.sh`, compute sha256, sed-replace `PAI_INSTALLER_SHA256` in `install.sh`. Commit on change.
9. Bun: pin to specific version, fetch sha256 from `https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/SHASUMS256.txt` for both arches.
10. Tailscale: signed apt repo handles transitively via `apt-get install`.
11. **CI gate:** `.github/workflows/pin-bot.yml` runs weekly. On hash diff: open PR. Reviewer manually inspects upstream diff before merge. Document in `docs/HARDENING.md`.

### Phase 5: Docs + tests (1.5 days)

12. Rewrite `README.md` ~50 lines.
13. Write `docs/QUICKSTART.md` ≤ 1 page: Hetzner CX22 + DO $6/mo walkthroughs with screenshots. Install command uses raw github URL with `v0.1.0` tag.
14. Update `docs/THREAT_MODEL.md` "Implementation Mapping": each threat row → `install.sh:<lines>` or `gateway/server.ts:<fn>`.
15. Delete `gap.md`. Update `CLAUDE.md` ISC backlog (Phase 0 step 4).
16. **Tests:**
    - `src/gateway/auth.test.ts`: brute-force loop hits 429; cookie HMAC tamper rejected; expiry past TTL rejected; entropy ≥60 bits per RFC 4648 base32 alphabet
    - `src/gateway/server.test.ts`: pulse path allowlist (`/`, `/healthz`, `/api/pulse/x`, `/admin` reject, `/pulse..` reject); method allowlist; body cap; `/terminal` 410
    - **`src/gateway/integration.test.ts` (NEW per Critic):** start gateway → pair → cookie → call `reset-access` → restart gateway → old cookie returns 401
    - `tests/preserve-claude.sh`: in container with seeded `~/.claude`, run install, compute snapshot diff using:
      ```bash
      find ~/.claude -type f -print0 | sort -z | xargs -0 sha256sum > before.txt
      # ... run install ...
      find ~/.claude -type f -print0 | sort -z | xargs -0 sha256sum > after.txt
      diff before.txt after.txt   # must be empty
      ```
    - `tests/sha256-mismatch.sh`: serve mutated installer locally, run install.sh with override URL, expect non-zero exit
    - `tests/uninstall-safety.sh`: install → record extra unowned file in target dirs → run uninstall → assert unowned file survives
    - `tests/manifest-completeness.sh`: run install in container, compare `find / -newer <preflight-marker> -type f` against `jq -r '.path' install-manifest.jsonl`
    - `tests/pairing-code-leak.sh`: install with `2>&1 | tee log.txt`, assert `! grep <pairing> log.txt`
    - CI: `shellcheck -S warning install.sh uninstall.sh scripts/*.sh`

### Phase 6: VPS matrix (1 day)

17. Run `scripts/vps-smoke.sh` on Hetzner CX22 (Ubuntu 22.04, 24.04, Debian 12). Save evidence in `docs/VPS_TEST_RESULTS.md`.
18. Mobile manual: iPhone Safari + Android Chrome → tailnet URL → pair → Pulse loads.

### Phase 7: Release v0.1 (0.5 day)

19. Tag `v0.1.0`. README install command points at `https://raw.githubusercontent.com/<org>/pai-anywhere/v0.1.0/install.sh` (immutable tag).
20. Open PR/comment on PAI Discussion #617 / #922 with link.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Upstream PAI installer changes shape, SHA-256 mismatch breaks installs | High | High | `scripts/pin-installer.sh` weekly CI auto-PR; manual review of upstream diff before merge; doctor probe warns when pin file mtime > 14d |
| `install.sh` non-portability between distros | Med | Med | POSIX bash; apt-get only in v0.1; preflight refuses non-Ubuntu/Debian; doctor warns |
| Bash idempotency drift past 350 LOC | Med | Med | Each function `if-not-already-X` gated; shellcheck CI blocks merge; budget rebumped to ~350 SLOC stripped (was 300, realistic) |
| Tailscale apt key rotation | Low | Med | Document fingerprint inline; doctor probe checks key validity; CI test installs in fresh image weekly |
| Pairing code leaked via scrollback (`curl \| tee log`) | Med | High | Code never goes through stdout in raw form: written to `/var/lib/pai-anywhere/pairing-code.txt` (0600), printed via `clear; printf` then `read -p "press enter once recorded"`; trap EXIT reminds to run `reset-access` if scrollback was captured; AC-21 covers this |
| Single global rate-limit DoS by tailnet member | Low | Low | 15-min lockout; `reset-access` rotates code; tailnet members already trust-boundary-internal |
| Pulse upstream adds new path; allowlist over-blocks | Low | Low | Allowlist tunable via `PAI_ANYWHERE_PULSE_ALLOW_PATHS` env var; release notes call out updates |
| Browser terminal still wanted; 410 frustration | Med | Low | 410 body links to roadmap issue; v0.2 milestone; `docs/QUICKSTART.md` mentions "Pulse-only in v0.1" |
| LOC budget overrun (>700 final TS, >350 install.sh) | Med | Low | Each PR after Phase 2 must be net-zero or net-negative LOC unless adding test; `cloc` check in CI |
| Manifest JSONL corruption | Low | Med | `install.sh` appends only; `uninstall.sh` validates each line as JSON via `jq` before acting; corrupt line → uninstall aborts with manual-review message |
| Architect's principle violation (Reversibility silently dropped) | — | — | RESOLVED via JSONL audit manifest; Phase 0 step 4 amends CLAUDE.md to name the mechanism |
| Architect's verify/doctor over-split | — | — | RESOLVED via Phase 2c fold |
| Architect's URL inconsistency | — | — | RESOLVED: raw github URL with `v0.1.0` tag everywhere; no `pai-anywhere.dev`; Phase 7 step 19 + AC-12 + dropped Migration Note all aligned |
| Critic's `sha256sum -r` non-flag bug | — | — | RESOLVED via `find … -print0 \| sort -z \| xargs -0 sha256sum` in Phase 5 step 16 + AC-10 |
| Critic's AC-15 over-removal of persisted schema strings | — | — | RESOLVED: AC-15 now allowlists `gateway-secrets.v1`, `session.v1`, `install-manifest.v1` |
| Critic's missing pre-mortem | — | — | RESOLVED via `## Pre-Mortem` section below |

---

## Pre-Mortem (deliberate mode — 3 distinct failure scenarios)

### Scenario 1: SHA-256 pin-bot rubber-stamp lets through compromised upstream

**Narrative:** Week 8 post-launch. `ourpai.ai` is compromised at the edge for 6 hours. During the compromise, our weekly `pin-bot.yml` cron fires, fetches the malicious `install.sh`, opens PR "bump PAI installer hash to <new>". A maintainer merges fast because hash bumps have been routine for weeks. Next user paste-install runs malicious code as root.

**Detection:** community user reports unexpected behavior; doctor probe shows unfamiliar binary in `/home/pai/.claude`.

**Mitigation:**
- Pin-bot PR template **MUST** include a diff of the upstream installer body (not just the hash). Reviewer must read diff.
- Pin-bot opens PR labeled `pin-bot` only; humans cannot merge labeled-only PRs without a second-reviewer approval (`CODEOWNERS` rule).
- v0.1 doctor probe verifies upstream installer's *behavior* by sandboxed dry-run match against expected file-creation set (deferred to v0.2 if too expensive; v0.1 docs explicit about review responsibility).

### Scenario 2: `uninstall.sh` orphans paths after partial-failure install

**Narrative:** User runs install.sh. Phase 7 (Tailscale Serve) fails because of network blip. install.sh's ERR trap calls uninstall.sh. uninstall.sh reads `install-manifest.jsonl` — but install.sh appended the systemd-unit lines just before the trap fired. Some manifest entries reference paths that were created; some reference paths that were *about* to be created. uninstall.sh tries to rm a path that doesn't exist → noisy but harmless. UNLESS the order was: (a) write systemd unit, (b) `record` mutation. If (a) succeeds, (b) doesn't, uninstall doesn't know about the unit → orphan service file.

**Mitigation:**
- `record()` is called *before* the mutation, not after. Manifest is "intent log," not "completion log." Worst case: uninstall tries to delete a path that doesn't exist → harmless.
- `uninstall.sh` treats `ENOENT` as "already-clean," not error.
- Integration test `tests/partial-install-rollback.sh`: kill install.sh mid-run between phases, run uninstall.sh, assert no orphaned files in `/etc`, `/var/lib`, `/opt`, `/etc/systemd/system/pai-*`.

### Scenario 3: Pulse allowlist too tight after Pulse upstream releases v6 with new endpoint

**Narrative:** PAI v6 releases. New Pulse endpoint at `/api/v2/pulse/notifications`. Our allowlist has `/api/pulse/` only. Users who upgrade Pulse via PAI's own update path see "404 not found" on every notification call. Forum complaints, mass downgrade.

**Detection:** doctor probe fetches Pulse `/healthz` and discovers route via OPTIONS or `/api/pulse/__routes` if upstream provides; emits warning when upstream paths exist that aren't in our allowlist. (Upstream Pulse must support route discovery for this to work; v0.1 ships best-effort.)

**Mitigation:**
- `PAI_ANYWHERE_PULSE_ALLOW_PATHS` env var lets advanced users widen allowlist without code change.
- Release notes mandate allowlist review on every upstream Pulse minor version bump.
- v0.2 backlog: add automated Pulse route compatibility test in `pin-bot` flow.

---

## Expanded Test Plan

| Layer | Test | Tool |
|---|---|---|
| **Unit** | Pairing code entropy ≥120 bits | `bun test auth.test.ts` |
| **Unit** | Cookie HMAC tampering rejected | `bun test` |
| **Unit** | Cookie expiry past TTL rejected | `bun test` |
| **Unit** | Pulse path allowlist (5 cases: pass `/`, pass `/healthz`, pass `/api/pulse/foo`, reject `/admin`, reject `/pulse..`) | `bun test server.test.ts` |
| **Unit** | Method allowlist (GET/POST/HEAD pass; DELETE/PUT/PATCH 405) | `bun test` |
| **Unit** | Body cap > 1MB → 413 | `bun test` |
| **Unit** | `/terminal` returns 410 with `roadmap` field | `bun test` |
| **Unit** | Rate limit: 11th attempt within 15 min → 429 (injectable clock) | `bun test` |
| **Unit** | Gateway refuses start without `PAI_ANYWHERE_PAIRING_CODE` env | `bun test` |
| **Integration** | `reset-access` rotates secrets → restart gateway → old cookie returns 401 | `bun test integration.test.ts` |
| **Integration** | install.sh runs in podman Ubuntu 24.04 image, exit 0, manifest non-empty | `tests/container-install.sh` |
| **Integration** | sha256 mismatch path: install.sh aborts, no useradd, no /opt mutation | `tests/sha256-mismatch.sh` |
| **Integration** | uninstall.sh removes only manifest-listed paths; unowned file in target dir survives | `tests/uninstall-safety.sh` |
| **Integration** | Partial-install rollback: kill mid-Phase 7, run uninstall.sh, no orphans | `tests/partial-install-rollback.sh` |
| **e2e** | Hetzner CX22 fresh Ubuntu 24.04: paste curl, login Tailscale, mobile Safari opens private URL, enters code, sees Pulse | manual matrix run |
| **e2e** | DigitalOcean $6/mo droplet Debian 12: same flow | manual matrix run |
| **e2e** | `~/.claude` byte-identical preservation (find + sort + sha256sum) | `tests/preserve-claude.sh` |
| **e2e** | Pairing code never appears in tee'd log | `tests/pairing-code-leak.sh` |
| **Observability (minimal)** | install.sh emits structured progress lines (`[phase=foundation status=ok]`) | `tests/log-format.sh` |
| **Observability (minimal)** | gateway logs to systemd journal at info/warn/error; no pairing code in logs | `journalctl -u pai-anywhere \| grep <code>` empty |
| **Observability (minimal)** | doctor `--json` emits stable schema (no metrics requirement for v0.1) | `bun run doctor --json \| jq -e '.checks'` |

> Note: full metrics/tracing observability is out of v0.1 scope per Non-goals. Minimal log discipline only.

---

## Verification Steps

1. **LOC check (stripped):**
   ```bash
   cloc --quiet install.sh uninstall.sh scripts/*.sh    # report comment vs code lines
   cloc --quiet --not-match-f='\.test\.ts$' src/         # ≤600 SLOC
   ```

2. **Schema-version sweep (allowlisted):**
   ```bash
   ! grep -rE 'pai-anywhere\.(install-plan|install-execution|rollback-plan|rollback-apply|reset-access|full-install|doctor|verify)\.v[0-9]' src/
   ```

3. **Test suite:**
   ```bash
   bun test
   shellcheck -S warning install.sh uninstall.sh scripts/*.sh
   ```

4. **Fresh-VPS smoke (Hetzner CX22 Ubuntu 24.04):**
   ```bash
   ssh root@<vps> 'curl -fsSL https://raw.githubusercontent.com/<org>/pai-anywhere/v0.1.0/install.sh | bash'
   # mobile browser → tailnet URL → enter code → pulse loads
   ```

5. **`~/.claude` preservation (FIXED command):**
   ```bash
   find ~/.claude -type f -print0 | sort -z | xargs -0 sha256sum > before.txt
   curl … | bash
   find ~/.claude -type f -print0 | sort -z | xargs -0 sha256sum > after.txt
   diff before.txt after.txt   # must be empty
   ```

6. **Hash-pinning enforcement:**
   ```bash
   # serve mutated installer; install.sh aborts non-zero
   PAI_INSTALLER_URL=http://localhost:8000/tampered.sh ./install.sh
   echo $?  # non-zero
   grep "sha256 mismatch" install.log
   ```

7. **Gateway security:**
   - Brute force: 11 attempts/15min → 429
   - `curl -X DELETE gateway/pulse/foo` → 405
   - `curl gateway/pulse/admin/secret` → 404
   - Cookie last-byte-flipped → 401
   - `/terminal` → 410, body has `"roadmap"`
   - Gateway refuses to start with `PAI_ANYWHERE_PAIRING_CODE` unset

8. **Uninstall safety:**
   ```bash
   ./uninstall.sh
   # /opt/pai-anywhere, /etc/pai-anywhere, /var/lib/pai-anywhere all gone
   # /home/<user>/.claude UNCHANGED (find ... | xargs sha256sum diff empty)
   # systemd units removed
   # any unowned file placed in target dirs SURVIVES
   ```

9. **Manifest completeness (scope-anchored):**
   ```bash
   touch /tmp/preflight-marker
   ./install.sh
   # restrict find to manifest-anchored prefixes only — exclude apt/dpkg/systemd side-effects
   find /etc/pai-anywhere /var/lib/pai-anywhere /opt/pai-anywhere /home/pai \
        /etc/systemd/system/pai-pulse.service /etc/systemd/system/pai-anywhere.service \
        -newer /tmp/preflight-marker -type f 2>/dev/null | sort > fs-actual.txt
   jq -r '.path' /etc/pai-anywhere/install-manifest.jsonl | sort -u > manifest-recorded.txt
   # symmetric diff must be empty (modulo ENOENT entries flagged in manifest)
   diff fs-actual.txt manifest-recorded.txt
   ```

10. **Pairing code log leak:**
    ```bash
    ./install.sh 2>&1 | tee install-log.txt
    grep -F "$(cat /var/lib/pai-anywhere/pairing-code.txt)" install-log.txt   # empty
    ```

---

## Estimated Effort (revised)

| Phase | Time |
|---|---|
| 0. Capture state + CLAUDE.md amend | 1.5h |
| 1. install.sh + uninstall.sh (idempotency rigor) | 1.5d |
| 2. Slim TS (gut, delete, refold verify→doctor) | 1.5d |
| 3. Gateway security | 0.5d |
| 4. Hash pinning + CI bots | 0.5d |
| 5. Docs + tests (expanded) | 1.5d |
| 6. VPS matrix | 1d |
| 7. Release | 0.5d |
| **Total** | **~7 days** |

---

## File Inventory After Strip

```
pai-anywhere/
├── install.sh                       ~350 SLOC NEW
├── uninstall.sh                     ~80 LOC NEW
├── README.md                        ~50 LOC rewrite
├── CLAUDE.md                        Reversibility row amended; ISC backlog dropped
├── package.json                     simplified scripts
├── .github/workflows/
│   ├── shellcheck.yml               NEW
│   └── pin-bot.yml                  NEW
├── scripts/
│   ├── pin-installer.sh             ~40 LOC NEW
│   ├── vps-smoke.sh                 keep
│   └── collect-diagnostics.sh       keep
├── src/
│   ├── cli.ts                       ~80 LOC (was 326)
│   ├── gateway/
│   │   ├── server.ts                ~200 LOC (was 314)
│   │   ├── auth.ts                  ~120 LOC (was 153)
│   │   ├── server.test.ts           ~80 LOC NEW
│   │   ├── auth.test.ts             ~60 LOC NEW
│   │   ├── integration.test.ts      ~50 LOC NEW
│   │   └── types.ts                 ~25 LOC
│   ├── doctor/                       (verify folded in)
│   │   ├── inspect.ts               ~150 LOC
│   │   ├── probes.ts                ~200 LOC (was verify/probes.ts 545 LOC)
│   │   ├── report.ts                ~50 LOC
│   │   └── types.ts                 ~25 LOC
│   └── lib/
│       └── paths.ts                 ~30 LOC
├── systemd/                          keep templates as heredoc source
├── docs/
│   ├── QUICKSTART.md                NEW: Hetzner + DO walkthroughs
│   ├── THREAT_MODEL.md              update Implementation Mapping
│   ├── HARDENING.md                 keep, document pin policy + Pulse allowlist SOP
│   └── VPS_TEST_RESULTS.md          populated by Phase 6
├── tests/
│   ├── preserve-claude.sh           NEW
│   ├── sha256-mismatch.sh           NEW
│   ├── uninstall-safety.sh          NEW
│   ├── partial-install-rollback.sh  NEW
│   ├── manifest-completeness.sh     NEW
│   ├── pairing-code-leak.sh         NEW
│   ├── container-install.sh         NEW
│   └── log-format.sh                NEW
└── (deleted)
    ├── gap.md
    ├── docs/MIGRATION.md            (no v0.0 users)
    ├── src/install/                 entire dir
    ├── src/rollback/                entire dir
    ├── src/access/                  entire dir
    ├── src/verify/                  entire dir (folded into doctor)
    └── src/lib/{manifest,redaction,command,listeners}.ts
```

Estimated final: ~700 LOC TS + ~470 LOC bash + tests. Threat model intact. Reversibility preserved via JSONL audit manifest. Security gaps closed.

---

## Resolved Decisions

1. **Install URL:** `https://raw.githubusercontent.com/<org>/pai-anywhere/v0.1.0/install.sh` everywhere. No `pai-anywhere.dev` domain. No DNS, no operational burden.
2. **Hash pinning:** weekly auto-PR via `pin-bot.yml`; manual review with upstream-diff visible in PR body; `CODEOWNERS` requires second reviewer for `pin-bot`-labeled PRs.
3. **`gap.md`:** delete. Project archaeology lives in git history.
4. **v0.0 migration:** none. No deployed users. No `docs/MIGRATION.md`.
5. **Telegram:** drop entirely. No code, no config, no docs.
6. **Reversibility (post-Architect):** preserved via bash-written JSONL audit manifest at `/etc/pai-anywhere/install-manifest.jsonl`. CLAUDE.md amended to name the mechanism.
7. **verify/doctor (post-Architect):** folded into single `doctor/` module.
8. **Rate limit (post-Critic):** v0.1 ships single global bucket only. Tailscale-User-Login per-user upgrade deferred to v0.2.
9. **Allowlist tunability (post-Critic):** `PAI_ANYWHERE_PULSE_ALLOW_PATHS` env var.
10. **install.sh signing (deferred):** v0.1 relies on github TLS + tag-pinned URL. GPG signature deferred to v0.2.

---

## ADR — Architecture Decision Record

**Decision:** Strip pai-anywhere to hybrid bash `install.sh` + slim TS gateway/doctor (~700 LOC TS + ~470 LOC bash).

**Drivers:**
1. Distribution success on fresh VPS in <5 min
2. Security gap closure (XFF rate-limit, 6-digit code, unpinned curl|sh)
3. LOC discipline (5238 → ~700 TS)
4. Reversibility constraint preservation
5. Community auditability

**Alternatives considered:**
- Option B (pure bash + Caddy): rejected; HMAC cookie + path allowlist programmability lost
- Option C (TS-only refactor): rejected; misses LOC + community-friction drivers; lib/command.ts already shells out
- Option D (bash JSONL manifest): accepted, merged into chosen Option A

**Why chosen:** A satisfies all 5 drivers. B fails Driver 5 (3-language complexity). C fails Drivers 1+3. D synthesis preserves Driver 4 without infrastructure cost.

**Consequences:**
- (+) Auditable via shellcheck + bun test, dual CI gates
- (+) Community contributions easier via bash for system mutations
- (+) Reversibility honored via JSONL manifest
- (−) Two languages to maintain
- (−) Bash idempotency requires `if-not-already-X` rigor, slips LOC budget by ~50

**Follow-ups:**
- v0.2: terminal bridge with separate threat model
- v0.2: Tailscale-User-Login per-user rate limit upgrade
- v0.2: `install.sh` GPG signature
- v0.3: Fedora/Arch support
- v0.3: Ansible playbook

---

## Changelog (this revision)

Applied from Architect+Critic round 1:
- **Reversibility restored** via JSONL audit manifest (Architect synthesis option a, Critic accepted)
- **Install URL unified** — single source of truth, raw github + v0.1.0 tag (Critic CRITICAL #2)
- **AC-15 tightened** — allowlist on-disk schemas, blocklist legacy install/rollback schemas (Critic CRITICAL #3)
- **Pre-mortem added** — 3 distinct failure scenarios with specific mitigations (Critic CRITICAL #1)
- **`sha256sum -r` fixed** to `find … | sort | xargs sha256sum` (Critic finding #5)
- **AC-19 added** — shellcheck CI gate (Architect + Critic agreement)
- **AC-20 added** — manifest completeness verification
- **AC-21 added** — pairing code log-leak verification
- **Verify folded into doctor** (Architect architectural soundness #5)
- **Phase 2 deletion order specified** (Critic Executor perspective)
- **Alternatives section made explicit** (Critic Skeptic perspective)
- **Migration Note section deleted** (Resolved Decision #4 finally applied)
- **`docs/MIGRATION.md` removed from File Inventory**
- **`install/foundation.ts` duplicate listing removed**
- **AC-2 verification fixed** — uses `cloc` not raw `wc -l`
- **Rate limit choice locked** — single global bucket only for v0.1 (Critic Ambiguity)
- **Pulse allowlist tunability locked** — env var (Critic Ambiguity)
- **Effort revised** 5.5d → 7d (idempotency + expanded tests + JSONL manifest)
- **`/etc/pai-anywhere/VERSION` row dropped from risks** (no v0.0 users per Resolved #4)

### Round 2 final refinements (Architect APPROVED, Critic APPROVE WITH IMPROVEMENTS)

Applied:
- **AC-20 scope-anchored** — find restricted to `/etc/pai-anywhere`, `/var/lib/pai-anywhere`, `/opt/pai-anywhere`, `/home/pai`, pai-* unit files; excludes apt/dpkg/systemd transitive side-effects to eliminate false-positive surface
- **AC-11 ENOENT-vs-unowned semantic locked** — ENOENT = clean (skip), EACCES/owner-mismatch/symlink-where-file-expected = abort, unowned-paths-inside-target-dirs = preserved
- **Header LOC clarified** — `~700 TS + ~470 bash` matches ADR Consequences

Outstanding (executor-time, not plan-blocking per both reviewers):
- AC-12 screenshot capture step in Phase 6 docs phase
- `pin-bot.yml` CODEOWNERS rule realization (configurable in GitHub branch protection — confirm with `gh repo edit` at release time)

---

## Consensus Verdict

- **Architect (round 2):** APPROVE
- **Critic (round 2):** APPROVE WITH IMPROVEMENTS (all applied above)

Plan ready for execution. Hand to `/oh-my-claudecode:ralph` (sequential, verifier-gated) or `/oh-my-claudecode:team` (parallel pipeline). Recommend `team` given 7 distinct phases with limited shared state past Phase 0.
