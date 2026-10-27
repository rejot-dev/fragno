---
"@fragno-dev/db": patch
"@fragno-dev/lofi": patch
---

feat: schemas can drop a table with `dropTable()`. Its migration drops the table only if it exists,
so a schema can restore an `addTable()` an earlier release replaced with `noOp()` and drop it. Lofi
skips the outbox rows of tables a registered schema dropped instead of failing on them.
