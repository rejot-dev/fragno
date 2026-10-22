---
"@fragno-dev/db": patch
---

refactor!: remove `markHookFailed` from the durable hooks service. Hook processing already settles
failed attempts; let a hook throw instead of marking it failed yourself.
