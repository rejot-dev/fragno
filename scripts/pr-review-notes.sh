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
repository_owner="${repository%%/*}"
repository_name="${repository#*/}"

printf '# Review notes for PR #%s: %s\n\n' "$pr_number" "$pr_title"
printf '%s\n\n' "$pr_url"

review_threads="$(
  gh api graphql --paginate --slurp \
    -F owner="$repository_owner" \
    -F name="$repository_name" \
    -F number="$pr_number" \
    -f query='query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $endCursor) {
            nodes {
              isResolved
              path
              line
              originalLine
              comments(first: 100) {
                nodes {
                  author { login }
                  body
                  createdAt
                  replyTo { id }
                  url
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }'
)"

unresolved_comments="$(
  jq -c '[
    .[].data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved | not)
    | . as $thread
    | .comments.nodes[]
    | {
        path: $thread.path,
        line: ($thread.line // $thread.originalLine),
        author: (.author.login // "ghost"),
        createdAt,
        isReply: (.replyTo != null),
        body,
        url
      }
  ]' <<<"$review_threads"
)"
comment_count="$(jq 'length' <<<"$unresolved_comments")"

if [[ "$comment_count" -eq 0 ]]; then
  printf '_No unresolved review notes._\n'
  exit 0
fi

printf '_%s unresolved review note%s._\n\n' \
  "$comment_count" \
  "$([[ "$comment_count" -eq 1 ]] && printf '' || printf 's')"

jq -r '
  .[] |
  "## " + .path +
  (if .line then ":" + (.line | tostring) else "" end) + "\n\n" +
  "**@" + .author + "** · " + .createdAt +
  (if .isReply then " · reply" else "" end) + "\n\n" +
  .body + "\n\n" +
  "[View on GitHub](" + .url + ")\n"
' <<<"$unresolved_comments"
