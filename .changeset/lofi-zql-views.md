---
"@fragno-dev/lofi": patch
---

feat: `@fragno-dev/lofi/zql` and `@fragno-dev/lofi/zql/worker` run ZQL queries against the SQLite
replica in a dedicated worker and keep their results up to date incrementally as outbox entries
arrive, reading rows from SQLite on demand instead of holding the tables in memory
