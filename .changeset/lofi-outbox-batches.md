---
"@fragno-dev/lofi": patch
---

feat: `LofiClient` applies the outbox entries that have arrived in batches through the new required
`LofiAdapter.applyOutboxBatch`, and `onSyncApplied` and `onSyncComplete` run once per batch. The
SQLite replica commits each batch, and its cursor, in one transaction; a failing entry rolls back
its batch. Custom adapters implement `applyOutboxBatch(apply)` as `apply(this)` to keep committing
each entry on its own.
