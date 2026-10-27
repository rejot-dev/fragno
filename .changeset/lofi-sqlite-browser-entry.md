---
"@fragno-dev/lofi": patch
---

feat: the SQLite replica runs only in replica workers, through `@fragno-dev/lofi/sqlite/worker`, and
needs `@journeyapps/wa-sqlite` 2.x, whose OPFS VFS no longer races other workers at startup. lofi no
longer depends on `@tanstack/browser-db-sqlite-persistence`.

fix: the synchronous connection that replica workers' views read through returns text as it was
stored: a NUL no longer ends it, and a leading byte order mark is kept.
