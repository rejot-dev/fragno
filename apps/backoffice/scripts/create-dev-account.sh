#!/usr/bin/env bash
set -euo pipefail

BACKOFFICE_URL="${BACKOFFICE_URL:-http://localhost:5173}"
MAX_RETRIES=10
EMAIL="${BACKOFFICE_EMAIL:-${USER}@rejot.dev}"
PASSWORD="${BACKOFFICE_PASSWORD:-wachtwoord}"

if [[ -z "${USER:-}" && -z "${BACKOFFICE_EMAIL:-}" ]]; then
  echo "USER is not set. Set BACKOFFICE_EMAIL explicitly." >&2
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      if [[ $# -lt 2 ]]; then
        echo "Usage: $0 [-p|--port PORT]" >&2
        exit 1
      fi
      PORT="$2"
      if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
        echo "Port must be numeric: $PORT" >&2
        exit 1
      fi
      BACKOFFICE_URL="$(
        printf '%s' "$BACKOFFICE_URL" |
          sed -E "s#^(https?://[^/ :]+)(:[0-9]+)?(.*)\$#\1:${PORT}\3#"
      )"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [-p|--port PORT]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [-p|--port PORT]" >&2
      exit 1
      ;;
  esac
done

url="${BACKOFFICE_URL%/}/api/auth/sign-up"
body=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")

response_file=$(mktemp)
attempt=1
status=""
curl_exit=0

while true; do
  : > "$response_file"
  set +e
  status=$(curl \
    --silent \
    --show-error \
    --output "$response_file" \
    --write-out "%{http_code}" \
    --header "Content-Type: application/json" \
    --request POST \
    --data "$body" \
    "$url")
  curl_exit=$?
  set -e

  if [[ $curl_exit -eq 0 ]]; then
    break
  fi

  if [[ $curl_exit -eq 7 && $attempt -lt $MAX_RETRIES ]]; then
    echo "Backoffice not ready yet (attempt $attempt/$MAX_RETRIES), retrying in 1s..."
    sleep 1
    attempt=$((attempt + 1))
    continue
  fi

  echo "Failed to create dev account: curl error $curl_exit" >&2
  cat "$response_file" >&2
  exit 1
done

case "$status" in
  200|201)
    echo "Created dev account: $EMAIL"
    ;;
  400)
    if grep -q 'email_already_exists' "$response_file"; then
      echo "Dev account already exists: $EMAIL"
    else
      echo "Failed to create dev account: HTTP $status" >&2
      cat "$response_file" >&2
      exit 1
    fi
    ;;
  *)
    echo "Failed to create dev account: HTTP $status" >&2
    cat "$response_file" >&2
    exit 1
    ;;
esac

rm -f "$response_file"
