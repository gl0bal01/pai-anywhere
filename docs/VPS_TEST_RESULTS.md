# pai-anywhere VPS Test Results

This file is the release evidence ledger. Do not mark a row `pass` unless it was generated from disposable VPS smoke output plus manual laptop/mobile checks.

Current production status: `pending`.

## Required Rows

| ID | Provider | OS | Existing `~/.claude` | Expected Result | Status | Evidence |
|---|---|---|---|---|---|---|
| VPS-A | Provider A | Ubuntu LTS | yes | install, verify, reboot verify, mobile access, rollback | pending | |
| VPS-B | Provider B | Debian stable or Ubuntu LTS | no | install, verify, reboot verify, mobile access, rollback | pending | |

## How To Generate A Result

On a disposable VPS, keep the output directories from each phase:

```bash
bun run vps:smoke
bun run vps:smoke -- --apply
sudo reboot
bun run vps:smoke -- --post-reboot
bun run vps:smoke -- --rollback
```

After manual laptop/mobile checks, generate the result block:

```bash
scripts/vps-matrix-result.sh \
  --id VPS-A \
  --provider "Provider name" \
  --os "Ubuntu 24.04 LTS" \
  --existing-claude yes \
  --baseline .pai-anywhere-test-BASELINE \
  --apply .pai-anywhere-test-APPLY \
  --post-reboot .pai-anywhere-test-POST-REBOOT \
  --rollback .pai-anywhere-test-ROLLBACK \
  --laptop-pass \
  --mobile-pass \
  --public-ip-blocked
```

Paste the generated block below.

## Result Blocks

No completed VPS result blocks yet.
