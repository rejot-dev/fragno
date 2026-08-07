#!/usr/bin/env bash

set -euo pipefail

command -v gh >/dev/null 2>&1 || {
  echo "error: gh is required" >&2
  exit 1
}

pr_number="$(gh pr view --json number --jq '.number')"
pr_title="$(gh pr view --json title --jq '.title')"
pr_url="$(gh pr view --json url --jq '.url')"
repository="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"

printf '# Review notes for PR #%s: %s\n\n' "$pr_number" "$pr_title"
printf '%s\n\n' "$pr_url"

comment_count="$(
  gh api --paginate "repos/$repository/pulls/$pr_number/comments?per_page=100" \
    --jq 'length' |
    awk '{ total += $1 } END { print total + 0 }'
)"

if [[ "$comment_count" -eq 0 ]]; then
  printf '_No review notes._\n'
  exit 0
fi

printf '_%s review note%s._\n\n' \
  "$comment_count" \
  "$([[ "$comment_count" -eq 1 ]] && printf '' || printf 's')"

gh api --paginate "repos/$repository/pulls/$pr_number/comments?per_page=100" --jq '
  .[] |
  "## " + .path +
  (if .line then ":" + (.line | tostring)
   elif .original_line then ":" + (.original_line | tostring)
   else ""
   end) + "\n\n" +
  "**@" + .user.login + "** · " + .created_at +
  (if .in_reply_to_id then " · reply" else "" end) + "\n\n" +
  .body + "\n\n" +
  "[View on GitHub](" + .html_url + ")\n"
'
