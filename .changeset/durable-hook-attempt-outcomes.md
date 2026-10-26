---
"@fragno-dev/db": patch
---

feat: report each committed durable-hook attempt outcome (`completed`, `retry-scheduled`, or
`failed`) to `DurableHooksInstrumentation.observeAttemptOutcome()`
