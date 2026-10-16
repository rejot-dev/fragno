---
"@fragno-dev/backoffice-api": patch
---

feat: declare app actions with revisions, require `actionsRevision` for `apps.install`, add
`apps.installations.approveActions`, give `BackofficeApp` a permanent `slug` (`appSlugSchema`), and
add `v0/app-actions` to verify Backoffice's signed action requests.
