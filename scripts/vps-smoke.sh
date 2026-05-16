#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${PAI_ANYWHERE_TEST_OUTPUT_DIR:-"$ROOT_DIR/.pai-anywhere-test-$(date -u +%Y%m%dT%H%M%SZ)"}"
SUMMARY="$OUTPUT_DIR/summary.txt"
BUN_BIN="${BUN_BIN:-$(command -v bun 2>/dev/null || true)}"
APPLY=0
POST_REBOOT=0
ROLLBACK=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --post-reboot) POST_REBOOT=1 ;;
    --rollback) ROLLBACK=1 ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/vps-smoke.sh [--apply] [--post-reboot] [--rollback]

Default mode is read-only baseline: doctor, verify-expected-fail, diagnostics.
--apply runs install.sh with sudo/root then verifies.
--post-reboot runs verification and service diagnostics after reboot.
--rollback runs uninstall.sh --rollback with sudo/root.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$OUTPUT_DIR"
: > "$SUMMARY"

pass_count=0
fail_count=0
skip_count=0

log() {
  printf '%s\n' "$*" | tee -a "$SUMMARY"
}

redact_stream() {
  sed -E \
    -e 's/sk-ant-api[a-zA-Z0-9_-]{20,}/[REDACTED_ANTHROPIC_KEY]/g' \
    -e 's/sk-[a-zA-Z0-9]{20,}/[REDACTED_API_KEY]/g' \
    -e 's/(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{20,}/[REDACTED_GITHUB_TOKEN]/g' \
    -e 's/github_pat_[a-zA-Z0-9_]{40,}/[REDACTED_GITHUB_PAT]/g' \
    -e 's/tskey-[a-zA-Z0-9_-]{20,}/[REDACTED_TAILSCALE_KEY]/g' \
    -e 's#https://[^/@[:space:]]+:[^/@[:space:]]+@#https://[REDACTED_CREDENTIALS]@#g' \
    -e 's/pai_anywhere_session=[^;[:space:]]+/pai_anywhere_session=[REDACTED_COOKIE]/g'
}

run_step() {
  local name="$1"
  shift
  local outfile="$OUTPUT_DIR/$name.log"

  log ""
  log "== $name =="
  log "Command: $*"

  (cd "$ROOT_DIR" && "$@") >"$outfile.raw" 2>&1
  local status=$?
  redact_stream <"$outfile.raw" >"$outfile"
  rm -f "$outfile.raw"

  if [ "$status" -eq 0 ]; then
    log "PASS $name"
    pass_count=$((pass_count + 1))
  else
    log "FAIL $name exit=$status"
    fail_count=$((fail_count + 1))
  fi
  return "$status"
}

run_expected_fail() {
  local name="$1"
  shift
  local outfile="$OUTPUT_DIR/$name.log"

  log ""
  log "== $name =="
  log "Command: $*"

  (cd "$ROOT_DIR" && "$@") >"$outfile.raw" 2>&1
  local status=$?
  redact_stream <"$outfile.raw" >"$outfile"
  rm -f "$outfile.raw"

  if [ "$status" -ne 0 ]; then
    log "PASS $name failed closed as expected"
    pass_count=$((pass_count + 1))
    return 0
  fi

  log "FAIL $name unexpectedly passed"
  fail_count=$((fail_count + 1))
  return 1
}

run_optional() {
  local name="$1"
  shift
  local outfile="$OUTPUT_DIR/$name.log"

  log ""
  log "== $name =="
  log "Command: $*"

  (cd "$ROOT_DIR" && "$@") >"$outfile.raw" 2>&1
  local status=$?
  redact_stream <"$outfile.raw" >"$outfile"
  rm -f "$outfile.raw"

  if [ "$status" -eq 0 ]; then
    log "PASS $name"
    pass_count=$((pass_count + 1))
  else
    log "SKIP $name exit=$status"
    skip_count=$((skip_count + 1))
  fi
  return 0
}

sudo_cmd() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return $?
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo -E "$@"
    return $?
  fi

  echo "Root or sudo is required for this step." >&2
  return 127
}

run_sudo_step() {
  local name="$1"
  shift
  local outfile="$OUTPUT_DIR/$name.log"

  log ""
  log "== $name =="
  log "Command: sudo/root $*"

  (cd "$ROOT_DIR" && sudo_cmd "$@") >"$outfile.raw" 2>&1
  local status=$?
  redact_stream <"$outfile.raw" >"$outfile"
  rm -f "$outfile.raw"

  if [ "$status" -eq 0 ]; then
    log "PASS $name"
    pass_count=$((pass_count + 1))
  else
    log "FAIL $name exit=$status"
    fail_count=$((fail_count + 1))
  fi
  return "$status"
}

snapshot_claude() {
  local label="$1"
  local outfile="$OUTPUT_DIR/claude-$label.sha256"
  local claude_dir="${HOME}/.claude"

  if [ ! -d "$claude_dir" ]; then
    printf 'missing %s\n' "$claude_dir" >"$outfile"
    return 0
  fi

  (
    cd "$claude_dir" || exit 0
    find . -type f -size -2M -print0 2>/dev/null \
      | sort -z \
      | xargs -0 -r sha256sum 2>/dev/null
  ) >"$outfile"
}

compare_claude() {
  if cmp -s "$OUTPUT_DIR/claude-before.sha256" "$OUTPUT_DIR/claude-after.sha256"; then
    log "PASS human ~/.claude hash snapshot unchanged"
    pass_count=$((pass_count + 1))
  else
    log "FAIL human ~/.claude hash snapshot changed"
    fail_count=$((fail_count + 1))
  fi
}

write_context() {
  {
    echo "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "hostname=$(hostname 2>/dev/null || true)"
    echo "user=$(id -un 2>/dev/null || true)"
    echo "uid=$(id -u 2>/dev/null || true)"
    echo "root_dir=$ROOT_DIR"
    echo "output_dir=$OUTPUT_DIR"
    echo ""
    if [ -r /etc/os-release ]; then
      cat /etc/os-release
    fi
  } | redact_stream >"$OUTPUT_DIR/context.txt"
}

main() {
  log "pai-anywhere VPS smoke"
  log "Output: $OUTPUT_DIR"

  if [ -z "$BUN_BIN" ]; then
    log "FAIL bun is not available on PATH. Install Bun before running this smoke script."
    exit 127
  fi

  log "Bun: $BUN_BIN"
  write_context
  snapshot_claude before

  run_step doctor "$BUN_BIN" run src/cli.ts doctor --json

  if [ "$APPLY" -eq 1 ]; then
    run_sudo_step install bash "$ROOT_DIR/install.sh" || true
    snapshot_claude after
    compare_claude
    run_step verify-after-install "$BUN_BIN" run src/cli.ts verify --json || true
  elif [ "$POST_REBOOT" -eq 1 ]; then
    run_step verify-after-reboot "$BUN_BIN" run src/cli.ts verify --json || true
  else
    run_expected_fail verify-before-install "$BUN_BIN" run src/cli.ts verify --json
  fi

  if [ "$ROLLBACK" -eq 1 ]; then
    run_sudo_step rollback-apply bash "$ROOT_DIR/uninstall.sh" --rollback || true
  fi

  run_optional diagnostics scripts/collect-diagnostics.sh "$OUTPUT_DIR/diagnostics.txt"

  log ""
  log "Summary: pass=$pass_count fail=$fail_count skip=$skip_count"
  log "Output directory: $OUTPUT_DIR"

  if [ "$fail_count" -gt 0 ]; then
    exit 1
  fi
}

main "$@"
