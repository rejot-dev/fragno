---
"@fragno-dev/lofi": patch
---

feat: reconnect an outbox stream that stops delivering without closing. A stream that sends nothing,
not even a heartbeat, for `streamIdleTimeoutMs` (15 seconds by default) fails its read with "nothing
arrived for N s" and reconnects; `LofiSqliteReplica` accepts the same option and reports the failure
to every tab while it keeps the replicated data.
