#!/usr/bin/env bash

set -euo pipefail

declare -a LINT_PATHS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      while [[ $# -gt 0 ]]; do
        LINT_PATHS+=("$1")
        shift
      done
      ;;
    *)
      LINT_PATHS+=("$1")
      shift
      ;;
  esac
done

if [[ ${#LINT_PATHS[@]} -eq 0 ]]; then
  LINT_PATHS=(".")
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required but not installed." >&2
  exit 1
fi

set +e
pnpm exec oxlint -f json "${LINT_PATHS[@]}" \
| jq '
  .diagnostics |= (
    map(select(.code == "eslint(complexity)"))
    | map(
      . + {
        complexity: (
          try (
            .message
            | capture("complexity of (?<value>[0-9]+)")
            | .value
            | tonumber
          ) catch null
        )
      }
    )
    | sort_by(.complexity)
    | reverse
  ) | .diagnostics
'
set -e
