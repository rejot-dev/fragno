---
"@fragno-dev/db": patch
---

fix: an empty `in` list now matches no rows, and an empty `not in` list every row, instead of
failing with a syntax error on PostgreSQL and MySQL.
