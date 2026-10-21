---
"@fragno-dev/db": minor
---

feat: `alterTable()` can drop regular columns (`dropColumn`), keeping the table's rows. Drop a
column's indexes first; ID, system, and reference columns cannot be dropped. A SQLite rebuild now
keeps a column renamed to a name dropped or renamed away in the same step.
