#!/usr/bin/env bash

set -euo pipefail

command -v gh >/dev/null 2>&1 || {
  echo "error: gh is required" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || {
  echo "error: jq is required" >&2
  exit 1
}

poll_interval_seconds="${POLL_INTERVAL_SECONDS:-15}"
head_branch="$(git branch --show-current)"
if [[ -z "$head_branch" ]]; then
  echo "error: the current checkout is not on a branch" >&2
  exit 1
fi

pr_list_json="$(
  gh pr list \
    --head "$head_branch" \
    --state open \
    --limit 1 \
    --json number,url,state,headRefOid,reviewRequests,statusCheckRollup
)"
pr_json="$(jq -c '.[0] // empty' <<<"$pr_list_json")"
if [[ -z "$pr_json" ]]; then
  echo "No open pull request found for the current branch."
  exit 0
fi

pr_number="$(jq -r '.number' <<<"$pr_json")"
pr_url="$(jq -r '.url' <<<"$pr_json")"
repository="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"

check_state() {
  jq -r --arg check_name "$1" '
    [
      .statusCheckRollup[]?
      | select(
          ((.name // .context // .workflowName // "") | ascii_downcase | gsub("[^a-z0-9]"; "")) ==
          ($check_name | ascii_downcase | gsub("[^a-z0-9]"; ""))
        )
      | if .__typename == "CheckRun" then
          if .status == "COMPLETED" then "finished" else "waiting" end
        else
          if (.state == "PENDING" or .state == "EXPECTED") then "waiting" else "finished" end
        end
    ]
    | if length == 0 or any(. == "waiting") then "waiting" else "finished" end
  ' <<<"$pr_json"
}

copilot_review_is_requested() {
  jq -e '
    any(
      .reviewRequests[]?;
      ((.login // .name // "") | ascii_downcase | contains("copilot"))
    )
  ' <<<"$pr_json" >/dev/null
}

copilot_review_state() {
  local head_sha="$1"
  local reviews_json
  local review_found
  local comments_json
  local comment_found

  if ! reviews_json="$(
    gh api --paginate --slurp "repos/$repository/pulls/$pr_number/reviews?per_page=100"
  )"; then
    echo "error: failed to load pull request reviews" >&2
    return 1
  fi
  if ! review_found="$(
    jq -r --arg head_sha "$head_sha" '
      any(
        .[][];
        (.commit_id == $head_sha) and
        ((.user.login // "") | ascii_downcase | contains("copilot"))
      )
    ' <<<"$reviews_json"
  )"; then
    echo "error: failed to parse pull request reviews" >&2
    return 1
  fi
  if [[ "$review_found" == "true" ]]; then
    echo "finished"
    return 0
  fi

  if ! comments_json="$(
    gh api --paginate --slurp "repos/$repository/pulls/$pr_number/comments?per_page=100"
  )"; then
    echo "error: failed to load pull request review comments" >&2
    return 1
  fi
  if ! comment_found="$(
    jq -r --arg head_sha "$head_sha" '
      any(
        .[][];
        (.commit_id == $head_sha) and
        ((.user.login // "") | ascii_downcase | contains("copilot"))
      )
    ' <<<"$comments_json"
  )"; then
    echo "error: failed to parse pull request review comments" >&2
    return 1
  fi

  [[ "$comment_found" == "true" ]] && echo "finished" || echo "missing"
}

printf 'Waiting on PR #%s: %s\n' "$pr_number" "$pr_url"

while true; do
  coderabbit_state="$(check_state "CodeRabbit")"
  react_doctor_state="$(check_state "React Doctor")"
  copilot_state="not requested"
  head_sha="$(jq -r '.headRefOid' <<<"$pr_json")"

  if copilot_review_is_requested; then
    copilot_state="waiting"
  elif [[ "$(copilot_review_state "$head_sha")" == "finished" ]]; then
    copilot_state="finished"
  fi

  printf 'CodeRabbit: %s | React Doctor: %s | Copilot: %s\n' \
    "$coderabbit_state" "$react_doctor_state" "$copilot_state"

  if [[ "$coderabbit_state" == "finished" && "$react_doctor_state" == "finished" && "$copilot_state" != "waiting" ]]; then
    echo "Requested PR checks and reviews are finished."
    exit 0
  fi

  sleep "$poll_interval_seconds"
  pr_json="$(gh pr view "$pr_number" --json number,url,state,headRefOid,reviewRequests,statusCheckRollup)"
  if [[ "$(jq -r '.state' <<<"$pr_json")" != "OPEN" ]]; then
    echo "Pull request #$pr_number is no longer open."
    exit 0
  fi
done
