---
"@fragno-dev/lofi": patch
---

feat: add read views to the SQLite replica worker. `readViewEngine` runs named read functions, which
may run several queries, on the leading tab's connection with the database locked, again after every
batch, and sends a view's result only when it changed; pages open them with `lofiSqliteReadViews`.
