---
"@fragno-dev/lofi": patch
---

feat: the SQLite replica skips entries up to the last versionstamp it applied instead of recording
each entry in a `lofi_inbox` table. `LOFI_SQLITE_LAYOUT_VERSION` is now 2, so existing replicas
replay the outbox into a new database.
