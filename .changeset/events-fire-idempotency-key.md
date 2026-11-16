---
"@fragno-dev/backoffice-api": patch
---

feat: `events.fire` takes an `idempotencyKey`, so an event fired again stores nothing more, and an
`occurredAt`, so one sent late keeps its place in its type's state.
