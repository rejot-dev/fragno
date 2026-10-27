#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI_BIN="$REPO_ROOT/packages/fragment-upload/bin/run.js"
CLI_DIST="$REPO_ROOT/packages/fragment-upload/dist/cli/index.js"
BASE_URL_DEFAULT="http://localhost:5173/api/uploads"
BASE_URL="${FRAGNO_UPLOAD_BASE_URL:-$BASE_URL_DEFAULT}"

if [[ ! -f "$CLI_BIN" || ! -f "$CLI_DIST" ]]; then
  echo "CLI build not found. Building..."
  pnpm -C "$REPO_ROOT/packages/fragment-upload" build
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 [--https] <command> [args...]"
  echo "Default base URL: $BASE_URL_DEFAULT"
  echo "Example: $0 files list"
  echo "Example: $0 uploads create --provider files --file-key s~Zm9v --filename demo.txt --size-bytes 10 --content-type text/plain"
  exit 0
fi

if [[ "${1:-}" == "--https" ]]; then
  shift
  BASE_URL="${BASE_URL/http:\/\//https://}"
  NODE_TLS_REJECT_UNAUTHORIZED="0" FRAGNO_UPLOAD_BASE_URL="$BASE_URL" node "$CLI_BIN" "$@"
  exit 0
fi

FRAGNO_UPLOAD_BASE_URL="$BASE_URL" node "$CLI_BIN" "$@"
