---
"@fragno-dev/db": patch
---

Fix timestamp deserialization for PostgreSQL, MySQL, and CockroachDB. Previously, timestamp and date
columns were returned as strings instead of JavaScript Date objects. Now they are properly converted
to Date objects with full timezone support.
