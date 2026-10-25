---
"@fragno-dev/lofi": patch
"@fragno-dev/lofi-zql": patch
---

feat: `@fragno-dev/lofi/sqlite/worker` runs the SQLite replica in a dedicated worker per tab, where
one leading tab opens the replica and maintains every tab's live views; pages connect with
`connectLofiSqlite` and read live SQL views. The new `@fragno-dev/lofi-zql` package adds a view
engine that keeps ZQL query results up to date incrementally as outbox entries arrive, reading rows
from SQLite on demand instead of holding the tables in memory
