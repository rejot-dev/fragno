---
"@fragno-dev/forms": minor
---

Add durable form lifecycle hooks and replace unbounded submission reads with cursor-paginated pages.

This is a pre-1.0 breaking change: `listResponses` now accepts `SubmissionListOptions` and returns a
bounded page instead of accepting `SubmissionSortOptions` and returning an unbounded array.
