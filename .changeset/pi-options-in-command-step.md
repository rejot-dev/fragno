---
"@fragno-dev/pi-harness": patch
---

fix: interactive chat workflows resolve `options` inside each command step attempt, so an async
resolver may do I/O. A resolver that throws now errors the session at its first command instead of
at creation.
