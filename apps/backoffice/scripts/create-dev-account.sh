#!/usr/bin/env bash
set -euo pipefail

BACKOFFICE_URL="${BACKOFFICE_URL:-http://localhost:5173}"
EMAIL="${BACKOFFICE_EMAIL:-${USER}@rejot.dev}"
PASSWORD="${BACKOFFICE_PASSWORD:-wachtwoord}"

if [[ -z "${USER:-}" && -z "${BACKOFFICE_EMAIL:-}" ]]; then
  echo "USER is not set. Set BACKOFFICE_EMAIL explicitly." >&2
  exit 1
fi

url="${BACKOFFICE_URL%/}/api/auth/sign-up"
body=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")

response_file=$(mktemp)
status=$(curl \
  --silent \
  --show-error \
  --output "$response_file" \
  --write-out "%{http_code}" \
  --header "Content-Type: application/json" \
  --request POST \
  --data "$body" \
  "$url")

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
