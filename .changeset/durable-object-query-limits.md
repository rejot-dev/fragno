---
"@fragno-dev/db": patch
---

feat: refuse Durable Object SQLite queries binding more than 100 parameters, or a value over 2 MB,
with an error naming the query, and export `DURABLE_OBJECT_MAX_BOUND_PARAMETERS` from
`@fragno-dev/db/drivers`.
