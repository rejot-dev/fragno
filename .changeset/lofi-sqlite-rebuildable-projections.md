---
"@fragno-dev/lofi": patch
---

feat: rebuild SQLite replica projections from stored rows. A projection that declares `rebuild` (its
version, the source tables it replays, and the local tables it alone writes) no longer names the
replica's database. When its version or its tables change, the replica drops and recreates its
tables and runs it on the stored source rows, in the order the outbox delivered them, instead of
downloading the outbox again. `rebuildLofiSqliteProjections` in `@fragno-dev/lofi/sqlite/testing`
checks that a projection rebuilds to the rows the outbox built.
