---
"@fragno-dev/db": patch
---

fix: `starts with` and `not starts with` now match a literal, case-sensitive prefix on every
database, compiled to index range bounds instead of `LIKE`. `%` and `_` in the prefix are no longer
wildcards, SQLite no longer ignores ASCII case, and prefixes longer than Durable Object SQLite's
50-byte `LIKE` limit work. Code that relied on case-insensitive matching on SQLite must normalize
case itself.
