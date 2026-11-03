#!/usr/bin/env bash

set -euo pipefail

function print_usage() {
  cat <<'EOF'
Usage: push-to-main.sh

Fast-forwards the local main branch to the current worktree's HEAD, pushes
main to origin right after, so origin/main cannot move in between, then
rebases the current branch on main. Pulls main first when it is behind
origin/main. Refuses unless the worktree that has main checked out is
clean, main has not diverged from origin/main, the current branch is
rebased on main, and no merge, cherry-pick, or revert is in progress.
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

main_sha="$(git rev-parse main)"
head_sha="$(git rev-parse HEAD)"

if [[ "$main_sha" == "$head_sha" ]]; then
  # Still push below, so a failed push can be retried.
  echo "main is already at $current_branch ($(git rev-parse --short HEAD)); nothing to land."
else
  if ! git merge-base --is-ancestor main HEAD; then
    echo "error: $current_branch is not rebased on main; run pull-from-main.sh first." >&2
    exit 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "warning: $current_branch has uncommitted changes; only commits are landed." >&2
  fi

  echo "Landing on main:"
  git --no-pager log --oneline "main..HEAD"

  # Merging in the main worktree keeps its checkout in step with the moved branch.
  git -C "$main_worktree_path" merge --ff-only --quiet "$head_sha"

  echo "main is now at $(git rev-parse --short main)."
fi

if ! git push --quiet origin main; then
  echo "error: push failed; main is landed locally but not on origin." >&2
  exit 1
fi
echo "Pushed main to origin."

# Uncommitted changes would otherwise make the rebase refuse after main has moved.
git rebase --quiet --autostash main
