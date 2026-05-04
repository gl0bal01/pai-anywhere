# Encrypted Backups for pai-anywhere

Reference scripts to run a daily, age-encrypted snapshot of pai-anywhere state, with optional off-site push to S3-compatible storage. **Not** wired into `install.sh` — copy in only if you want this and have read the trade-offs.

## What gets backed up

```
home/pai/.claude       # PAI memory + Claude OAuth tokens
etc/pai-anywhere       # gateway.env, rclone.conf, install manifest, etc.
var/lib/pai-anywhere   # session secrets, pairing-code.txt, state
```

Excluded inside those paths: `node_modules/`, `.cache/`, `*.log`, `.npm/`, `.bun/install/cache/`.

## What you ship into place

| File in this directory          | Destination on host                      | Mode |
| ------------------------------- | ---------------------------------------- | ---- |
| `pai-backup`                    | `/usr/local/sbin/pai-backup`             | 0755 |
| `pai-backup.service`            | `/etc/systemd/system/pai-backup.service` | 0644 |
| `pai-backup.timer`              | `/etc/systemd/system/pai-backup.timer`   | 0644 |
| `backup-offsite.env.example`    | `/etc/pai-anywhere/backup-offsite.env.example` | 0644 |

The script reads the encryption recipient from `/root/.config/pai-backup/recipient.pub` and writes blobs to `/var/backups/pai-anywhere/pai-<UTC-stamp>.tar.age`. Local retention is 14 days.

## Prerequisites

```bash
sudo apt install age rclone
```

Versions known to work: `age 1.1.1+`, `rclone 1.60+`. The script uses `age -r <recipient>` and `rclone copy ... --no-traverse`; both are stable across recent versions.

## Setup

Run as root.

### 1. Generate the age keypair

```bash
sudo install -d -m 0700 /root/.config/pai-backup
sudo age-keygen -o /root/.config/pai-backup/identity.txt
sudo chmod 600 /root/.config/pai-backup/identity.txt
sudo grep '^# public key:' /root/.config/pai-backup/identity.txt \
  | awk '{print $4}' \
  | sudo tee /root/.config/pai-backup/recipient.pub > /dev/null
sudo chmod 644 /root/.config/pai-backup/recipient.pub
```

`identity.txt` is the only thing that can decrypt your backups. Treat it like a master key.

### 2. Install the script and units

From this directory:

```bash
sudo install -m 0755 pai-backup /usr/local/sbin/pai-backup
sudo install -m 0644 pai-backup.service /etc/systemd/system/pai-backup.service
sudo install -m 0644 pai-backup.timer   /etc/systemd/system/pai-backup.timer
sudo install -m 0644 backup-offsite.env.example /etc/pai-anywhere/backup-offsite.env.example
sudo systemctl daemon-reload
sudo systemctl enable --now pai-backup.timer
```

### 3. Smoke-test the pipeline

```bash
sudo /usr/local/sbin/pai-backup
# expect: backup_ok size=<bytes>B file=pai-<stamp>.tar.age kept=1 offsite=skipped
sudo ls -la /var/backups/pai-anywhere/
```

### 4. Confirm restore actually works

Before relying on the backup, prove the round-trip end-to-end:

```bash
LATEST=$(sudo ls -t /var/backups/pai-anywhere/ | head -1)
sudo age -d -i /root/.config/pai-backup/identity.txt < "/var/backups/pai-anywhere/$LATEST" \
  | tar -tzf - | head
```

If that lists real entries (`home/pai/.claude/...`), the backup is real. If anything fails, do not trust the snapshot.

### 5. Move the private key off-box

After step 4 passes, the on-box private key is now a liability. Save it to your password manager (label `pai-backup-identity`) plus at least one second offsite copy (encrypted USB, paper), verify the SHA-256 matches, then:

```bash
sudo shred -u /root/.config/pai-backup/identity.txt
sudo ls -la /root/.config/pai-backup/   # only recipient.pub should remain
```

The script keeps working — encryption only needs `recipient.pub`. Decryption requires retrieving the key from the offsite copy; VPS compromise after this step yields ciphertext only.

## Off-site push (optional)

The script will `rclone copy` the new snapshot to a remote *if* `/etc/pai-anywhere/backup-offsite.env` exists and sets `REMOTE=`. See `backup-offsite.env.example` and [`docs/HARDENING.md` § Encrypted Backups](../../docs/HARDENING.md) for the recommended bucket-isolated, per-service-rclone-config pattern.

Quick wire-up (Cloudflare R2):

```bash
# 1. Create a fresh bucket and a bucket-scoped API token in the R2 dashboard.
# 2. Drop credentials into the per-service config:
sudo install -d -m 0700 /etc/pai-anywhere
sudo tee /etc/pai-anywhere/rclone.conf > /dev/null <<EOF
[r2-pai]
type = s3
provider = Cloudflare
access_key_id = <KEY_ID>
secret_access_key = <SECRET>
region = auto
endpoint = https://<account-id>.r2.cloudflarestorage.com
no_check_bucket = true
EOF
sudo chmod 600 /etc/pai-anywhere/rclone.conf

# 3. Enable off-site push:
sudo install -m 0600 /etc/pai-anywhere/backup-offsite.env.example /etc/pai-anywhere/backup-offsite.env
sudo $EDITOR /etc/pai-anywhere/backup-offsite.env
# Set REMOTE=r2-pai:<your-bucket>/pai-anywhere and uncomment the export line.

# 4. Re-run; expect offsite=pushed_to_<remote>.
sudo /usr/local/sbin/pai-backup
```

Off-site push log: `/var/log/pai-backup-offsite.log` (rclone errors only).

## Daily operation

The timer fires at 03:17 UTC ± 10 minutes (`RandomizedDelaySec=600`) and is `Persistent=true`, so a missed run after downtime catches up on next boot.

Check status:

```bash
sudo systemctl list-timers pai-backup.timer
sudo journalctl -u pai-backup.service -n 20
sudo ls -lh /var/backups/pai-anywhere/
```

## Restore

End-to-end restore from a local file:

```bash
sudo age -d -i <path-to-identity.txt> < /var/backups/pai-anywhere/pai-<stamp>.tar.age \
  | sudo tar -xzf - -C /
```

Or from off-site:

```bash
sudo rclone copy r2-pai:<bucket>/pai-anywhere/pai-<stamp>.tar.age /tmp/
sudo age -d -i <path-to-identity.txt> < /tmp/pai-<stamp>.tar.age \
  | sudo tar -xzf - -C /
```

Restoring overwrites `/home/pai/.claude`, `/etc/pai-anywhere`, and `/var/lib/pai-anywhere`. After restore, run `sudo systemctl restart pai-anywhere.service pai-pulse.service`.

## Key rotation

To rotate the age recipient:

1. Generate a new keypair (step 1 above).
2. Run the backup once so a fresh blob lands under the new key.
3. Verify decrypt with the new identity.
4. Move the new identity offsite, shred local, replace the password-manager entry.
5. Old blobs remain decryptable only with the old identity — keep that copy archived for as long as you need to read the old snapshots.

## Why this is in `extras/`, not `install.sh`

- Backup choices are opinionated (age vs gpg, daily vs hourly, what to include, off-site shape). The installer stays mechanism-light.
- A failed backup script that the user did not opt into is worse than no backup at all.
- The default install footprint keeps to "what is required for pai-anywhere to function" — backups are a separate operator decision.

If you copy these files into place, you own them. The repo will not silently update them; pull and re-`install` if you want script changes.
