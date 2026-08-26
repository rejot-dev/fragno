#!/usr/bin/env bash
set -euo pipefail

BACKOFFICE_URL="${BACKOFFICE_URL:-https://backoffice.rejot.dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_VARS_FILE="${BACKOFFICE_DEV_VARS_FILE:-${SCRIPT_DIR}/../.dev.vars}"
LOCAL_PORT=5173
email=""

usage() {
  echo "Usage: pnpm --filter @fragno-apps/backoffice-rr admin:grant -- [--local] [--port PORT] EMAIL" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)
      BACKOFFICE_URL="http://localhost:${LOCAL_PORT}"
      shift
      ;;
    -p|--port)
      if [[ $# -lt 2 || ! "$2" =~ ^[0-9]+$ ]]; then
        echo "--port requires a numeric port." >&2
        usage
        exit 1
      fi
      LOCAL_PORT="$2"
      BACKOFFICE_URL="http://localhost:${LOCAL_PORT}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -* )
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -n "$email" ]]; then
        echo "Only one email address may be provided." >&2
        usage
        exit 1
      fi
      email="$1"
      shift
      ;;
  esac
done

if [[ -z "$email" ]]; then
  usage
  exit 1
fi

token="${AUTH_ADMIN_GRANT_TOKEN:-}"

if [[ -z "$token" && -f "$DEV_VARS_FILE" ]]; then
  token_line="$(grep -m 1 '^AUTH_ADMIN_GRANT_TOKEN=' "$DEV_VARS_FILE" || true)"
  token="${token_line#AUTH_ADMIN_GRANT_TOKEN=}"
fi

if [[ -z "$token" ]]; then
  echo "AUTH_ADMIN_GRANT_TOKEN is not set in the environment or $DEV_VARS_FILE." >&2
  exit 1
fi

body="$(EMAIL="$email" node -e '
  process.stdout.write(JSON.stringify({ email: process.env.EMAIL }));
')"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

status="$(curl \
  --silent \
  --show-error \
  --output "$response_file" \
  --write-out "%{http_code}" \
  --header "Authorization: Bearer $token" \
  --header "Content-Type: application/json" \
  --request POST \
  --data "$body" \
  "${BACKOFFICE_URL%/}/api/admin/grant")"

if [[ "$status" != "200" ]]; then
  echo "Failed to grant Backoffice administrator access: HTTP $status" >&2
  cat "$response_file" >&2
  exit 1
fi

result="$(node - "$response_file" <<'NODE'
const fs = require("node:fs");
const response = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (response.status === "granted") {
  process.stdout.write(`Granted administrator access to ${response.userId}.`);
} else if (response.status === "already_admin") {
  process.stdout.write(`Account ${response.userId} is already an administrator.`);
} else if (response.status === "email_not_verified") {
  process.stderr.write(`Account ${response.userId} must verify its email before becoming an administrator.\n`);
  process.exit(1);
} else {
  process.stderr.write(`Administrator access was not granted: ${response.status}.\n`);
  process.exit(1);
}
NODE
)"

echo "$result"
