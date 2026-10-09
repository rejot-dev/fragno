---
"@fragno-dev/github-app-fragment": patch
---

feat: add the `onRepositoryLinkStatusChanged` durable hook. It receives
`{ linkKey, repositoryId, fullName, status }` when a repository link is created or removed, when the
repository leaves the installation, and when the installation becomes active or stops being active.

feat: export `GITHUB_APP_FALLBACK_LINK_KEY`, the link key used when neither the request nor
`defaultLinkKey` names one.
