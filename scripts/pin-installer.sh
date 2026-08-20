#!/usr/bin/env bash
# scripts/pin-installer.sh — fetch upstream hashes and update install.sh constants.
# Usage:  bash scripts/pin-installer.sh
#         BUN_VERSION=1.3.14 bash scripts/pin-installer.sh  (override Bun version)
# Idempotent: no-op if all three hashes already match.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="${SCRIPT_DIR}/../install.sh"

# Single source of truth: hash EXACTLY what install.sh downloads. Deriving the
# URL from install.sh (instead of duplicating a constant here) guarantees the
# pin-bot can never certify content from a different origin than the one the
# installer actually fetches — a mismatch between the two previously went
# unnoticed (ourpai.ai here vs ourlifeos.ai in install.sh).
PAI_INSTALLER_URL="$(grep '^PAI_INSTALLER_URL=' "${INSTALL_SH}" | head -1 | cut -d'"' -f2)"
if [[ -z "${PAI_INSTALLER_URL}" ]]; then
  echo "[pin] ERROR: could not read PAI_INSTALLER_URL from ${INSTALL_SH}" >&2
  exit 1
fi

# Read current Bun version from install.sh
BUN_VERSION="${BUN_VERSION:-$(grep '^BUN_VERSION=' "${INSTALL_SH}" | head -1 | cut -d'"' -f2)}"
BUN_SHASUMS_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt"

echo "[pin] Fetching PAI installer from ${PAI_INSTALLER_URL} …"
tmpfile="$(mktemp /tmp/pai-installer-XXXXXX.sh)"
trap 'rm -f "${tmpfile}"' EXIT
curl -fsSL "${PAI_INSTALLER_URL}" -o "${tmpfile}"
pai_sha256="$(sha256sum "${tmpfile}" | awk '{print $1}')"
echo "[pin] PAI installer SHA-256: ${pai_sha256}"

echo "[pin] Fetching Bun ${BUN_VERSION} SHASUMS from GitHub …"
shasums_file="$(mktemp /tmp/bun-SHASUMS-XXXXXX.txt)"
trap 'rm -f "${tmpfile}" "${shasums_file}"' EXIT
curl -fsSL "${BUN_SHASUMS_URL}" -o "${shasums_file}"

bun_x86="$(grep 'bun-linux-x64\.zip$' "${shasums_file}" | awk '{print $1}')"
bun_arm="$(grep 'bun-linux-aarch64\.zip$' "${shasums_file}" | awk '{print $1}')"
echo "[pin] Bun x86_64 SHA-256: ${bun_x86}"
echo "[pin] Bun arm64  SHA-256: ${bun_arm}"

# Check current values in install.sh
current_pai="$(grep '^PAI_INSTALLER_SHA256=' "${INSTALL_SH}" | cut -d'"' -f2)"
current_x86="$(grep '^BUN_SHA256_X86_64=' "${INSTALL_SH}" | cut -d'"' -f2)"
current_arm="$(grep '^BUN_SHA256_ARM64=' "${INSTALL_SH}" | cut -d'"' -f2)"

changed=0
if [[ "${current_pai}" != "${pai_sha256}" ]]; then
  sed -i "s|^PAI_INSTALLER_SHA256=.*|PAI_INSTALLER_SHA256=\"${pai_sha256}\"|" "${INSTALL_SH}"
  echo "[pin] Updated PAI_INSTALLER_SHA256"
  changed=1
fi
if [[ "${current_x86}" != "${bun_x86}" ]]; then
  sed -i "s|^BUN_SHA256_X86_64=.*|BUN_SHA256_X86_64=\"${bun_x86}\"|" "${INSTALL_SH}"
  echo "[pin] Updated BUN_SHA256_X86_64"
  changed=1
fi
if [[ "${current_arm}" != "${bun_arm}" ]]; then
  sed -i "s|^BUN_SHA256_ARM64=.*|BUN_SHA256_ARM64=\"${bun_arm}\"|" "${INSTALL_SH}"
  echo "[pin] Updated BUN_SHA256_ARM64"
  changed=1
fi

if [[ "${changed}" -eq 0 ]]; then
  echo "[pin] All hashes already up to date. No changes."
else
  echo "[pin] install.sh hash lines updated. Diff:"
  git -C "${SCRIPT_DIR}/.." diff install.sh || true
fi
