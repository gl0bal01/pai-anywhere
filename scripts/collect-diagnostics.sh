#!/usr/bin/env bash
set -u

OUT="${1:-/dev/stdout}"

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

section() {
  printf '\n## %s\n' "$1"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

safe_run() {
  printf '$ %s\n' "$*"
  "$@" 2>&1 || true
}

collect() {
  section "Host"
  safe_run date -u
  safe_run uname -a
  if [ -r /etc/os-release ]; then
    cat /etc/os-release
  fi
  safe_run id

  section "Commands"
  for cmd in bun git curl bash rsync tar tailscale systemctl ss lsof ufw fail2ban-client; do
    if have "$cmd"; then
      printf '%s=%s\n' "$cmd" "$(command -v "$cmd")"
    else
      printf '%s=missing\n' "$cmd"
    fi
  done

  section "Versions"
  have bun && safe_run bun --version
  have git && safe_run git --version
  have tailscale && safe_run tailscale version

  section "pai-anywhere paths"
  for path in /etc/pai-anywhere /var/lib/pai-anywhere /opt/pai-anywhere /home/pai /home/pai/.claude; do
    if [ -e "$path" ]; then
      safe_run ls -ld "$path"
    else
      printf 'missing %s\n' "$path"
    fi
  done

  section "systemd"
  if have systemctl; then
    safe_run systemctl is-active pai-pulse.service
    safe_run systemctl is-active pai-anywhere.service
    safe_run systemctl status pai-pulse.service --no-pager --lines=20
    safe_run systemctl status pai-anywhere.service --no-pager --lines=20
  else
    echo "systemctl missing"
  fi

  section "listeners"
  if have ss; then
    safe_run ss -lntup
  elif have lsof; then
    safe_run lsof -nP -iTCP -sTCP:LISTEN
  else
    echo "ss and lsof missing"
  fi

  section "tailscale"
  if have tailscale; then
    safe_run tailscale status
    safe_run tailscale serve status
  else
    echo "tailscale missing"
  fi

  section "manifest"
  if [ -f /etc/pai-anywhere/install-manifest.jsonl ]; then
    sed -E 's/"sessionSecret": *"[^"]+"/"sessionSecret": "[REDACTED]"/g' /etc/pai-anywhere/install-manifest.jsonl
  else
    echo "manifest missing"
  fi
}

collect | redact_stream >"$OUT"
printf 'diagnostics written to %s\n' "$OUT"
