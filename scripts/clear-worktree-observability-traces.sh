#!/usr/bin/env bash

set -euo pipefail

function print_usage() {
  cat <<'EOF'
Usage: clear-worktree-observability-traces.sh [--dry-run | --execute]

Lists the Backoffice Miniflare observability trace stores in every worktree.
The default --dry-run mode reports their disk usage without deleting anything.
Use --execute after stopping Wrangler and Miniflare development processes.
EOF
}

function get_worktree_display_name() {
  local worktree_path="$1"
  local main_worktree_path="$2"

  if [[ "$worktree_path" == "$main_worktree_path" ]]; then
    printf 'main\n'
  else
    printf '%s\n' "${worktree_path##*/}"
  fi
}

function reject_symlinked_path_components() {
  local path="$1"
  local current_path=""
  local path_component
  local remaining_path="$path"

  if [[ "$remaining_path" == /* ]]; then
    current_path="/"
    remaining_path="${remaining_path#/}"
  fi

  while [[ -n "$remaining_path" ]]; do
    if [[ "$remaining_path" == */* ]]; then
      path_component="${remaining_path%%/*}"
      remaining_path="${remaining_path#*/}"
    else
      path_component="$remaining_path"
      remaining_path=""
    fi
    [[ -n "$path_component" ]] || continue

    if [[ "$current_path" == "/" ]]; then
      current_path="/$path_component"
    elif [[ -n "$current_path" ]]; then
      current_path="$current_path/$path_component"
    else
      current_path="$path_component"
    fi

    if [[ -L "$current_path" ]]; then
      echo "error: refusing to clear a path containing a symlink: $current_path" >&2
      return 1
    fi
  done
}

mode="dry-run"
case "${1:-}" in
  "" | --dry-run)
    ;;
  --execute)
    mode="execute"
    ;;
  --help | -h)
    print_usage
    exit 0
    ;;
  *)
    print_usage >&2
    exit 1
    ;;
esac

if [[ $# -gt 1 ]]; then
  print_usage >&2
  exit 1
fi

repository_root="$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)"
git_common_directory="$(git -C "$repository_root" rev-parse --path-format=absolute --git-common-dir)"
main_worktree_path="$(dirname "$git_common_directory")"
trace_store_relative_path="apps/backoffice/.wrangler/state/v3/observability/miniflare-wobs-trace-store"
worktree_list_file="$(mktemp "${TMPDIR:-/tmp}/fragno-worktrees.XXXXXX")"
trap 'rm -f -- "$worktree_list_file"' EXIT

if ! git -C "$repository_root" worktree list --porcelain -z >"$worktree_list_file"; then
  echo "error: failed to list repository worktrees" >&2
  exit 1
fi

worktree_count=0
trace_store_count=0
while IFS= read -r -d '' field; do
  [[ "$field" == worktree\ * ]] || continue

  worktree_count=$((worktree_count + 1))
  worktree_path="${field#worktree }"
  trace_store_path="$worktree_path/$trace_store_relative_path"

  [[ -d "$trace_store_path" ]] || continue

  reject_symlinked_path_components "$trace_store_path"
  trace_store_count=$((trace_store_count + 1))

  if [[ "$mode" == "dry-run" ]]; then
    worktree_name="$(get_worktree_display_name "$worktree_path" "$main_worktree_path")"
    trace_store_disk_usage="$(du -sh -- "$trace_store_path")"
    read -r trace_store_size _ <<<"$trace_store_disk_usage"
    printf '%s %s\n' "$worktree_name" "$trace_store_size"
  fi
done <"$worktree_list_file"

if [[ "$worktree_count" -eq 0 ]]; then
  echo "error: Git returned no worktrees" >&2
  exit 1
fi

if [[ "$mode" == "dry-run" ]]; then
  echo
  echo "Dry run: $trace_store_count trace store(s). Use --execute after stopping Wrangler and Miniflare."
  exit 0
fi

cleared_worktree_count=0
while IFS= read -r -d '' field; do
  [[ "$field" == worktree\ * ]] || continue

  worktree_path="${field#worktree }"
  trace_store_path="$worktree_path/$trace_store_relative_path"
  [[ -d "$trace_store_path" ]] || continue

  reject_symlinked_path_components "$trace_store_path"
  worktree_name="$(get_worktree_display_name "$worktree_path" "$main_worktree_path")"
  echo "Clearing $worktree_name"
  rm -rf -- "$trace_store_path"
  cleared_worktree_count=$((cleared_worktree_count + 1))
done <"$worktree_list_file"

echo "Cleared observability trace stores in $cleared_worktree_count worktree(s)."
