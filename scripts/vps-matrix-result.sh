#!/usr/bin/env bash
set -u

ID=""
PROVIDER=""
OS_NAME=""
EXISTING_CLAUDE=""
BASELINE_DIR=""
APPLY_DIR=""
POST_REBOOT_DIR=""
ROLLBACK_DIR=""
LAPTOP=0
MOBILE=0
PUBLIC_BLOCKED=0
NOTES=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/vps-matrix-result.sh \
    --id VPS-A \
    --provider "Provider name" \
    --os "Ubuntu 24.04 LTS" \
    --existing-claude yes \
    --baseline .pai-anywhere-test-... \
    --apply .pai-anywhere-test-... \
    --post-reboot .pai-anywhere-test-... \
    --rollback .pai-anywhere-test-... \
    --laptop-pass \
    --mobile-pass \
    --public-ip-blocked \
    --notes "optional"

This script does not decide manual browser checks. Pass those explicitly only after
testing from a laptop and mobile device on the tailnet.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --id) ID="${2:-}"; shift 2 ;;
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    --os) OS_NAME="${2:-}"; shift 2 ;;
    --existing-claude) EXISTING_CLAUDE="${2:-}"; shift 2 ;;
    --baseline) BASELINE_DIR="${2:-}"; shift 2 ;;
    --apply) APPLY_DIR="${2:-}"; shift 2 ;;
    --post-reboot) POST_REBOOT_DIR="${2:-}"; shift 2 ;;
    --rollback) ROLLBACK_DIR="${2:-}"; shift 2 ;;
    --laptop-pass) LAPTOP=1; shift ;;
    --mobile-pass) MOBILE=1; shift ;;
    --public-ip-blocked) PUBLIC_BLOCKED=1; shift ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$ID" ]; then
  echo "--id is required" >&2
  exit 2
fi

status_for_dir() {
  local dir="$1"
  local required_name="$2"

  if [ -z "$dir" ]; then
    printf 'pending:%s output directory not provided' "$required_name"
    return 0
  fi

  if [ ! -d "$dir" ]; then
    printf 'fail:%s output directory does not exist: %s' "$required_name" "$dir"
    return 0
  fi

  if [ ! -f "$dir/summary.txt" ]; then
    printf 'fail:%s summary.txt missing in %s' "$required_name" "$dir"
    return 0
  fi

  local line
  line="$(grep -E 'Summary: pass=[0-9]+ fail=[0-9]+ skip=[0-9]+' "$dir/summary.txt" | tail -n 1 || true)"
  if [ -z "$line" ]; then
    printf 'fail:%s summary line missing in %s' "$required_name" "$dir"
    return 0
  fi

  local fails
  fails="$(printf '%s\n' "$line" | sed -E 's/.* fail=([0-9]+).*/\1/')"
  if [ "$fails" = "0" ]; then
    printf 'pass:%s passed (%s)' "$required_name" "$line"
  else
    printf 'fail:%s has failures (%s)' "$required_name" "$line"
  fi
}

status_bool() {
  local value="$1"
  local label="$2"
  if [ "$value" -eq 1 ]; then
    printf 'pass:%s confirmed' "$label"
  else
    printf 'pending:%s not confirmed' "$label"
  fi
}

claude_status() {
  local dir="$1"
  if [ -z "$dir" ]; then
    printf 'pending:human ~/.claude preservation not checked'
    return 0
  fi
  if [ ! -f "$dir/claude-before.sha256" ] || [ ! -f "$dir/claude-after.sha256" ]; then
    printf 'pending:human ~/.claude before/after snapshots missing'
    return 0
  fi
  if cmp -s "$dir/claude-before.sha256" "$dir/claude-after.sha256"; then
    printf 'pass:human ~/.claude snapshot unchanged'
  else
    printf 'fail:human ~/.claude snapshot changed'
  fi
}

print_check() {
  local result="$1"
  local status="${result%%:*}"
  local message="${result#*:}"
  printf '| %s | %s |\n' "$status" "$message"
}

overall_status() {
  local results=("$@")
  local pending=0
  for result in "${results[@]}"; do
    case "${result%%:*}" in
      fail) printf 'fail'; return 0 ;;
      pending) pending=1 ;;
    esac
  done
  if [ "$pending" -eq 1 ]; then
    printf 'pending'
  else
    printf 'pass'
  fi
}

baseline_result="$(status_for_dir "$BASELINE_DIR" baseline)"
apply_result="$(status_for_dir "$APPLY_DIR" apply)"
post_reboot_result="$(status_for_dir "$POST_REBOOT_DIR" post-reboot)"
rollback_result="$(status_for_dir "$ROLLBACK_DIR" rollback)"
claude_result="$(claude_status "$APPLY_DIR")"
laptop_result="$(status_bool "$LAPTOP" "laptop tailnet access")"
mobile_result="$(status_bool "$MOBILE" "mobile tailnet access")"
public_result="$(status_bool "$PUBLIC_BLOCKED" "public IP blocked")"

overall="$(overall_status \
  "$baseline_result" \
  "$apply_result" \
  "$post_reboot_result" \
  "$rollback_result" \
  "$claude_result" \
  "$laptop_result" \
  "$mobile_result" \
  "$public_result")"

provider="${PROVIDER:-unknown}"
os="${OS_NAME:-unknown}"
existing="${EXISTING_CLAUDE:-unknown}"
notes="${NOTES:-}"
evidence="baseline=${BASELINE_DIR:-missing}; apply=${APPLY_DIR:-missing}; post-reboot=${POST_REBOOT_DIR:-missing}; rollback=${ROLLBACK_DIR:-missing}"

cat <<EOF
## $ID

| Field | Value |
|---|---|
| Provider | $provider |
| OS | $os |
| Existing human \`~/.claude\` | $existing |
| Overall | $overall |
| Evidence | $evidence |
| Notes | $notes |

| Status | Check |
|---|---|
EOF

print_check "$baseline_result"
print_check "$apply_result"
print_check "$post_reboot_result"
print_check "$rollback_result"
print_check "$claude_result"
print_check "$laptop_result"
print_check "$mobile_result"
print_check "$public_result"

cat <<EOF

Matrix row:

| $ID | $provider | $os | $existing | install, verify, reboot verify, mobile access, rollback | $overall | $evidence |
EOF
