---
"@fragno-dev/lofi": patch
---

feat!: the SQLite replica worker serves only the view engines it is given; `replica.sql()` and the
built-in `"sql"` view kind are gone. Migrate: name each query as a read,
`(reader) => reader.query({ sql, params, columns })`, serve it with
`readViewEngine({ kind, reads })` in the worker's `engines`, and open it on the page with
`lofiSqliteReadViews<typeof reads>(kind)(replica, name, args)`.
