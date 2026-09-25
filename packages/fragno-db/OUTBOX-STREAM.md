# Outbox stream protocol 1

Request `GET /_internal/outbox/stream?protocol=1` on an outbox-enabled Fragment. Optional query
parameters are `afterVersionstamp` (an exclusive, lowercase 24-digit hexadecimal cursor) and `limit`
(the catch-up read size, 1–50; default 50). Shared live polling always uses 50-entry reads.

This is a breaking replacement for the unversioned, bare-entry stream. Missing or unsupported
protocol versions return HTTP 400 before streaming. Malformed cursors return 400; cursors ahead of
the source return 409. The paginated `/outbox` endpoint remains available independently.

Types and runtime frame validation are exported directly from `@fragno-dev/db/outbox-stream`. The
response is `application/x-ndjson`: each frame is one JSON object followed by a newline. Blank-line
heartbeats are no longer used.

## Frames

| Type        | Required fields                                                                                         | Meaning                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `started`   | `protocolVersion: 1`, `adapterIdentity`, `catchUpTargetVersionstamp: string \| null`, `catchUpPageSize` | First frame; identifies the source and fixes this response's catch-up target.                                 |
| `entry`     | `entry`                                                                                                 | Complete outbox entry, including its serialized payload, mutation operations, and reference map when present. |
| `caught-up` | `throughVersionstamp: string \| null`                                                                   | Every requested entry through the fixed target has been written. Emitted once per completed catch-up.         |
| `heartbeat` | none                                                                                                    | Transport liveness only, including while waiting for a catch-up scheduler turn.                               |
| `rotate`    | `reason: "lease-expired"`                                                                               | Final frame of a planned 30-second response rotation. Reconnect immediately.                                  |

The wire entry retains the full existing outbox entry shape. The exported `OutboxStreamEntry` type
is the projection consumers need; identity/timestamp storage fields are not needed for ingestion.
The serialized mutation payload remains opaque until its consumer decodes it.

## Fixed readiness boundary

The route captures adapter identity and the latest committed outbox versionstamp before sending
`started`. It does not hold a database snapshot or transaction for the lifetime of the response.
Entries are delivered in strictly increasing versionstamp order after the requested cursor.

For a target N, the sequence is:

```text
started(target=N)
entry(cursor+1) ... entry(N)
caught-up(through=N)
entry(N+1) ...
rotate(lease-expired)
EOF
```

Heartbeats may occur while catching up or live. If the source is empty, or the cursor already equals
N, `caught-up` requires no entry delivery. A commit after target capture is delivered after the
marker, including commits between capture and observer registration. Continuous writes cannot move
the fixed target or postpone its marker.

The server advances an observer cursor only after a successful entry write. The marker uses that
same serialized write path. Readiness and scheduler membership are separate: an observer joins
shared live polling only after its marker succeeds **and** its cursor reaches the existing live
observers. A historical observer may therefore receive `caught-up` yet continue receiving
independently scheduled reads until it reaches the live tail. Joining must never rewind the shared
live cursor. Catch-up observers with equal cursor and limit share reads even if their captured
targets differ; each receives its own marker at its own target.

## Reconnection and failures

Each response has a 30-second lease and one-second write timeout. A rotation request stops new entry
delivery to that observer, waits behind its in-flight write, writes `rotate`, and removes it. A
response may rotate before reaching its catch-up target. Its replacement captures a new fixed
target. There are no frames after `rotate`; EOF without it is interruption, not successful catch-up.

Client checkpoints advance only after successfully applying entries, not on receipt of a control
frame. Clients can safely commit a partial batch at planned rotation. On interruption, discard an
unapplied partial batch and resume from the last applied checkpoint. Replaying the exact checkpoint
entry allows validation that its `uowId` has not changed. Reject changed source identities before
applying any data from a replacement response.

No in-band error frame is needed: pre-stream failures use HTTP errors, and interrupted streams use
normal reconnect recovery. Unknown/malformed frames and illegal frame ordering are protocol errors,
not heartbeat or readiness signals.

## Resource guarantees

One adapter-owned hub schedules observations. Live observers run first, followed by at most four
catch-up cursor/limit groups per pass in round-robin order. Full pages and unserviced groups request
another bounded pass immediately, yielding to the event loop between passes. The 300 ms polling
interval applies only when no backlog remains (or a read failed); heartbeats retain their
per-observer cadence rather than being emitted on every rapid drain pass. Network writes retain
item-wise backpressure, failed observers do not terminate healthy observers, and bounded database
iterators are exhausted on cancellation so cursor-backed connections are released. Durable Object
SQLite pages are consumed before network awaits. Closing the final response ends recurring polling.
