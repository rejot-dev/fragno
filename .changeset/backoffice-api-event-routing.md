---
"@fragno-dev/backoffice-api": patch
---

feat: `events.get` returns the event's `routing`: `matching` until its routes are recorded, then
each matched route's status (`pending`, `retrying`, `completed` with its outcome, or `failed`),
failed attempts, and last error. The route outcome and state types are exported from `v0/events`.
