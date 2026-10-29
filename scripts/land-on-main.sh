#!/usr/bin/env bash

set -euo pipefail

function print_usage() {
  cat <<'EOF'
Usage: land-on-main.sh [--push | --pull]

Fast-forwards the local main branch to the current worktree's HEAD, then
rebases the current branch on main. Pulls main first when it is behind
origin/main. Refuses unless the worktree that has main checked out is
clean, main has not diverged from origin/main, the current branch is
rebased on main, and no merge, cherry-pick, or revert is in progress.

  --push  Push main to origin right after landing, so origin/main cannot
          move in between.
  --pull  Do not land: pull main from origin/main and rebase the current
          branch on it.
EOF
}

function find_main_worktree_path() {
  local worktree_path=""
  local line

  while IFS= read -r line; do
    case "$line" in
      "worktree "*) worktree_path="${line#worktree }" ;;
      "branch refs/heads/main")
        printf '%s\n' "$worktree_path"
        return 0
        ;;
    esac
  done < <(git worktree list --porcelain)

  return 1
}

push=false
pull=false
for arg in "$@"; do
  case "$arg" in
    --push) push=true ;;
    --pull) pull=true ;;
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

if [[ "$push" == true && "$pull" == true ]]; then
  echo "error: --pull does not land, so there is nothing to push." >&2
  exit 1
fi

current_branch="$(git branch --show-current)"
if [[ -z "$current_branch" ]]; then
  echo "error: HEAD is detached; check out the branch to land." >&2
  exit 1
fi
if [[ "$current_branch" == "main" ]]; then
  echo "error: already on main; run this from a feature worktree." >&2
  exit 1
fi

# The final rebase would fail after main has already moved. An unfinished
# rebase detaches HEAD, so the check above already refuses it.
for operation_head in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
  if [[ -e "$(git rev-parse --git-path "$operation_head")" ]]; then
    echo "error: $operation_head exists; finish or abort that operation first." >&2
    exit 1
  fi
done

if ! main_worktree_path="$(find_main_worktree_path)"; then
  echo "error: no worktree has main checked out." >&2
  exit 1
fi

# Untracked files count too: the fast-forward could overwrite them.
main_status="$(git -C "$main_worktree_path" status --porcelain)"
if [[ -n "$main_status" ]]; then
  echo "error: main worktree at $main_worktree_path is not clean:" >&2
  printf '%s\n' "$main_status" >&2
  exit 1
fi

git fetch --quiet origin main
if ! git merge-base --is-ancestor origin/main main; then
  # The main worktree is clean (checked above), so fast-forwarding it cannot lose work.
  if ! git -C "$main_worktree_path" merge --ff-only --quiet origin/main; then
    echo "error: main has diverged from origin/main; reconcile them in $main_worktree_path first." >&2
    exit 1
  fi
  echo "Pulled main to origin/main ($(git rev-parse --short main))."
fi

if [[ "$pull" == true ]]; then
  git rebase --quiet --autostash main
  echo "Rebased $current_branch on main ($(git rev-parse --short main))."
  exit 0
fi

main_sha="$(git rev-parse main)"
head_sha="$(git rev-parse HEAD)"

if [[ "$main_sha" == "$head_sha" ]]; then
  # Still push below, so a branch landed without --push can be pushed later.
  echo "main is already at $current_branch ($(git rev-parse --short HEAD)); nothing to land."
else
  if ! git merge-base --is-ancestor main HEAD; then
    echo "error: $current_branch is not rebased on main; run 'git rebase main' first." >&2
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

if [[ "$push" == true ]]; then
  if ! git push --quiet origin main; then
    echo "error: push failed; main is landed locally but not on origin." >&2
    exit 1
  fi
  echo "Pushed main to origin."
fi

# Uncommitted changes would otherwise make the rebase refuse after main has moved.
git rebase --quiet --autostash main
