# Sourced by push-to-main.sh and pull-from-main.sh.

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

# Checks that main can be moved from this worktree, then pulls main when it is
# behind origin/main. Sets current_branch and main_worktree_path.
function pull_main_from_feature_worktree() {
  current_branch="$(git branch --show-current)"
  if [[ -z "$current_branch" ]]; then
    echo "error: HEAD is detached; check out the branch to rebase." >&2
    exit 1
  fi
  if [[ "$current_branch" == "main" ]]; then
    echo "error: already on main; run this from a feature worktree." >&2
    exit 1
  fi

  # The final rebase would fail after main has already moved. An unfinished
  # rebase detaches HEAD, so the check above already refuses it.
  local operation_head
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
  local main_status
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
}
