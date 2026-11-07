---
"@fragno-dev/lofi": patch
---

feat: let a `LofiSqliteDatabase` run each transaction whole through `transaction`, for databases
that refuse `BEGIN`, such as Durable Object SQLite, and export `sqlStatementTransaction`
