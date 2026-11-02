---
"@fragno-dev/backoffice-api": patch
---

feat: add `router.accepts.list`, `router.accepts.create`, `router.accepts.update`, and
`router.accepts.delete`, which manage a scope's forward accepts: which scopes of other owners may
forward events into it, and which of their events it takes in. A forward into another owner's scope
now fails unless an enabled accept lets it in; System's forwards, and forwards between scopes of one
owner, need none. `AutomationIngestResult.accepted` is false for a forward no accept lets in.
