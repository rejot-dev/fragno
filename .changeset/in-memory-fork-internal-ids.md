---
"@fragno-dev/db": patch
---

fix: a forked in-memory adapter no longer restarts internal row ids, which let a write from the fork
overwrite an existing row in a shared table.
