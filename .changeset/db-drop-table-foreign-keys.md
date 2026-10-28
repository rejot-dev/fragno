---
"@fragno-dev/db": patch
---

fix: migrations that create and drop a table with a foreign key in one run, such as a new database
migrating a schema that dropped the table, no longer fail on PostgreSQL and MySQL.
