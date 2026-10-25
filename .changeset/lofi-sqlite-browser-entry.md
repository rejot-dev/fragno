---
"@fragno-dev/lofi": patch
---

feat!: move `openLofiSqliteReplica` to `@fragno-dev/lofi/sqlite/browser`, its only export, so apps
that open replicas in a worker of their own, through `@fragno-dev/lofi/sqlite/worker`, no longer
bundle the OPFS worker of `@tanstack/browser-db-sqlite-persistence`. Import it from the new entry.

lofi accepts `@journeyapps/wa-sqlite` 2.x, whose OPFS VFS no longer races other workers at startup.
`openLofiSqliteReplica` still needs 1.x, which `@tanstack/browser-db-sqlite-persistence` requires.

fix: the synchronous connection that replica workers' views read through returns text as it was
stored: a NUL no longer ends it, and a leading byte order mark is kept.
