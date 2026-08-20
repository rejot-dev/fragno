---
"@fragno-dev/db": patch
"@fragno-dev/workflows": patch
---

fix: retry workflow step inserts when Durable Object query errors wrap SQLite unique conflicts.
