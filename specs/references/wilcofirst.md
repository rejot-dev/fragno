# Wilcofirst Architecture Reference

Source: `/Users/wilco/dev/kc/kc/subjects/rejot/wilcofirst.md`

Notes (summary):

- Local-first architecture overview (stacked data stores, outbox sync, versionstamps).
- IndexedDB adapter and optimistic layering concepts.
- Sync conflict detection uses server-side command replay:
  - Client sends commands plus base server versionstamp and a conflict resolution strategy.
  - Server loads unseen events since base, maps command mutation targets (entity+pk), and conflicts
    if any unseen event touches those keys (atomic ops excluded).
  - Server runs a transaction with outbox version checks; if the outbox counter advances, it reloads
    unseen events and retries; write congestion after repeated retries.
- Client replays commands after applying unseen events; confirmed commands are removed from its
  outbox, conflicts stop the replay at the first unconfirmed command.
