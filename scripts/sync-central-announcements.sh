#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="${ROOT_DIR}/public/announcements.json"
SSH_CONFIG="${DSH_REMOTE_SSH_CONFIG:-/home/blank/.ssh/config}"
REMOTE_ALIAS="${DSH_REMOTE_ANNOUNCEMENTS_HOST:-tencent}"
REMOTE_DIR="/home/ubuntu/feedback-collector/data"
REMOTE_FILE="${REMOTE_DIR}/announcements.json"
REMOTE_TMP="${REMOTE_FILE}.upload"
PUBLIC_URL="${DSH_REMOTE_ANNOUNCEMENTS_URL:-https://vm-0-2-ubuntu.tail1f6fc4.ts.net/announcements.json}"

node -e "const fs=require('node:fs');const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(!Array.isArray(data?.items))throw new Error('announcements.items must be an array');" "${SOURCE_FILE}"

ssh -F "${SSH_CONFIG}" -o ClearAllForwardings=yes "${REMOTE_ALIAS}" "install -d -m 700 '${REMOTE_DIR}'"
scp -F "${SSH_CONFIG}" -o ClearAllForwardings=yes "${SOURCE_FILE}" "${REMOTE_ALIAS}:${REMOTE_TMP}"
ssh -F "${SSH_CONFIG}" -o ClearAllForwardings=yes "${REMOTE_ALIAS}" "python3 -m json.tool '${REMOTE_TMP}' >/dev/null && chmod 600 '${REMOTE_TMP}' && mv '${REMOTE_TMP}' '${REMOTE_FILE}'"

curl --fail --silent --show-error --max-time 15 "${PUBLIC_URL}?t=$(date +%s)" \
  | node -e "let raw='';process.stdin.on('data',chunk=>raw+=chunk).on('end',()=>{const data=JSON.parse(raw);if(!Array.isArray(data?.items))process.exit(1);console.log('central announcements synced:',data.items.length,'items')})"
