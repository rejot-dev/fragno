#!/usr/bin/env bash

set -euo pipefail

function print_usage() {
  cat <<'EOF'
Usage: pull-from-main.sh

Pulls main from origin/main when it is behind, then rebases the current
branch on main. Refuses unless the worktree that has main checked out is
clean, main has not diverged from origin/main, and no merge, cherry-pick,
or revert is in progress.
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h | --help)
      print_usage
      exit 0
      ;;
    *)
      print_usage >&2
      exit 1
      ;;
  esac
done

source "$(dirname "${BASH_SOURCE[0]}")/lib/sync-main.sh"

pull_main_from_feature_worktree

git rebase --quiet --autostash main
echo "Rebased $current_branch on main ($(git rev-parse --short main))."
