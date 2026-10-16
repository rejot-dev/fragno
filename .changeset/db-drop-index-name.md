---
"@fragno-dev/db": patch
---

fix: dropping an index works on SQLite and Postgres, and drops a unique index by its own name
instead of silently doing nothing.
