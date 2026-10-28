---
"@fragno-dev/lofi": patch
---

feat!: guarded SQL views refuse only what could break the leader: writes, transaction statements,
`ATTACH`/`DETACH`, and setting a pragma; `random()`, read pragmas, and any number of rows now work.
Migrate: replace `limits` with `operations` (thousands of operations per run); results no longer
carry `truncated`, and `LofiSqliteGuard` no longer takes `maxLength`.
