---
"@fragno-dev/backoffice-api": patch
---

feat!: app installations belong to an `owner`, an organization or a user, instead of an
`organizationId`; the resource scope approving everything the owner has is now `{ kind: "owner" }`.
