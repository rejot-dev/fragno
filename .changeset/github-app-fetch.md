---
"@fragno-dev/github-app-fragment": patch
---

feat: accept a `fetch` implementation in the fragment config for GitHub REST and OAuth requests

feat: add by-name repository routes. `GET /repositories/:owner/:repo` reports whether a repository
is reachable through an installation and whether it is linked;
`POST /repositories/:owner/:repo/link` and `POST /repositories/:owner/:repo/unlink` link and unlink
it by name.

feat: add `POST /repositories/:owner/:repo/api`, which proxies a REST request under
`/repos/{owner}/{repo}` for a linked repository using an installation token restricted to that
repository. GitHub error statuses are returned as results.
