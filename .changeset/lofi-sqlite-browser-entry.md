---
"@fragno-dev/lofi": patch
---

feat!: move `openLofiSqliteReplica` to `@fragno-dev/lofi/sqlite/browser`, its only export, so apps
that open replicas in a worker of their own, through `@fragno-dev/lofi/sqlite/worker`, no longer
bundle the OPFS worker of `@tanstack/browser-db-sqlite-persistence`. Import it from the new entry.
