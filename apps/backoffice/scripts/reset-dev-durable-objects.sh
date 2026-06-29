#!/usr/bin/env bash
set -euo pipefail

DO_STATE_DIR="${DO_STATE_DIR:-apps/backoffice/.wrangler/state/v3/do}"

if [[ ! -d "$DO_STATE_DIR" ]]; then
  echo "Durable Object state directory does not exist: $DO_STATE_DIR"
  exit 0
fi

shopt -s nullglob

removed=0
for path in "$DO_STATE_DIR"/*; do
  name="$(basename "$path")"
  case "$name" in
    *-Auth|*-Pi)
      echo "Keeping $name"
      ;;
    *)
      echo "Removing $name"
      rm -rf -- "$path"
      removed=$((removed + 1))
      ;;
  esac
done

echo "Removed $removed Durable Object state director$( [[ $removed -eq 1 ]] && echo y || echo ies )."
