#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI_BIN="$REPO_ROOT/packages/fragment-upload/bin/run.js"
CLI_DIST="$REPO_ROOT/packages/fragment-upload/dist/cli/index.js"
BASE_URL_PROXY_DEFAULT="http://localhost:5173/api/uploads-proxy"
BASE_URL_DIRECT_DEFAULT="http://localhost:5173/api/uploads-direct"
BASE_URL="${FRAGNO_UPLOAD_BASE_URL:-$BASE_URL_PROXY_DEFAULT}"

if [[ ! -f "$CLI_BIN" || ! -f "$CLI_DIST" ]]; then
  echo "CLI build not found. Building..."
  pnpm -C "$REPO_ROOT/packages/fragment-upload" build
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <command> [args...]"
  echo "Default base URL: $BASE_URL_PROXY_DEFAULT"
  echo "Options: --proxy | --direct"
  echo "Example: $0 files list"
  echo "Example: $0 uploads create --file-key s~Zm9v --filename demo.txt --size-bytes 10 --content-type text/plain"
  exit 0
fi

USE_HTTPS="false"
if [[ "${1:-}" == "--https" ]]; then
  USE_HTTPS="true"
  shift
fi

if [[ "${1:-}" == "--direct" ]]; then
  MODE="direct"
  shift
elif [[ "${1:-}" == "--proxy" ]]; then
  MODE="proxy"
  shift
else
  echo "Error: missing mode flag. Provide --proxy or --direct."
  exit 1
fi

if [[ -z "${FRAGNO_UPLOAD_BASE_URL:-}" ]]; then
  if [[ "$MODE" == "direct" ]]; then
    BASE_URL="$BASE_URL_DIRECT_DEFAULT"
  else
    BASE_URL="$BASE_URL_PROXY_DEFAULT"
  fi
fi

if [[ "$USE_HTTPS" == "true" ]]; then
  BASE_URL="${BASE_URL/http:\/\//https://}"
  NODE_TLS_REJECT_UNAUTHORIZED="0" FRAGNO_UPLOAD_BASE_URL="$BASE_URL" node "$CLI_BIN" "$@"
  exit 0
fi

FRAGNO_UPLOAD_BASE_URL="$BASE_URL" node "$CLI_BIN" "$@"
