---
"@fragno-dev/db": minor
---

Add `dropColumn` to `alterTable` for existing regular columns. Drop indexes on a column before
removing it; ID, system, and reference columns cannot be removed. The migration preserves other
columns and rows, including when SQLite rebuilds the table.
