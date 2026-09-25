# Framed outbox stream validation

Node v26.10.0; real localhost HTTP; measured SQLite server and separate unmeasured client process.
These are protocol/correctness smoke runs, not a repeated, alternating performance A/B.

## Shared live polling

Both runs used 1,000 measured 1 KiB entries, 100 historical entries, one origin/limit=1 observer,
and a 1 ms consumer delay. Current clients received `caught-up` before measured inserts and SQL
counter reset.

| Current clients | Duration | Measured outbox reads | Control frames including preparation |
| --------------- | -------- | --------------------- | ------------------------------------ |
| 1               | 6.121 s  | 40                    | 5                                    |
| 10              | 6.136 s  | 40                    | 86                                   |

All current clients consumed identical entry counts, payload bytes, and checksums. Control frames
are excluded from payload accounting and reported separately. Connection preparation contributes to
the control-frame count but not the measured SQL-read count.

## Mixed heavy workload

Two current clients, two divergent historical observers (origin/limit=1 and midpoint/limit=50),
1,000 historical entries, 1,000 measured entries, 128 KiB payloads, and 5 ms consumer delay:

- Duration: 13.829 s.
- Measured outbox reads: 60.
- Current-client aggregate payload: 250 MiB; checksum per client: 102,000.
- Historical progress: 22 and 1,014 entries.
- Control frames, including preparation: 14.
- Peak server V8 heap: 56.7 MiB; rise: 38.3 MiB.
- Peak RSS rise: 61.5 MiB; external-memory rise: 14.2 MiB.
- Retained heap delta after teardown and forced GC: −0.7 MiB.

An intermediate implementation allowed an observer reaching its fixed readiness target to join live
polling before reaching the existing live cursor. That rewound shared reads. The final hub separates
readiness from scheduler membership: it emits the finite `caught-up` marker immediately, but keeps a
still-lagging observer on independent bounded reads until joining cannot rewind the live cursor. A
regression test covers this distinction.

The allocation-profile analyzer successfully loaded the new metrics sidecar and reported 1,707.7 MiB
of sampled allocation churn. This is not retained memory, and SQLite native memory is not
represented in V8 heap profiles. The smoke run does not establish a product-level memory
improvement.

## Lease rotation and other consumers

A 5,200-entry live run lasted 31.266 s, crossing the 30-second lease for both current and historical
responses. Both ended with `expired`, reported zero server errors, and reconnected. The current
client consumed exactly 5,200 entries (checksum 530,400); the historical observer consumed 105. The
measured run used 210 outbox reads, including replacement-response startup reads.

A 100-entry polling smoke run still passed, reporting zero control frames. The deterministic
recorded Pi workflow stream workload also completed through the new protocol without model calls.

## Reproduction

```sh
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --stream --live --clients 1 --entries 1000 --history-entries 100 --payload-kib 1 --consumer-delay-ms 1
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --stream --live --clients 10 --entries 1000 --history-entries 100 --payload-kib 1 --consumer-delay-ms 1
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --stream --live --clients 2 --lagging-clients 2 --entries 1000 --history-entries 1000 --payload-kib 128 --consumer-delay-ms 5 --profile
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --stream --live --clients 1 --entries 5200 --history-entries 100 --payload-kib 1 --consumer-delay-ms 1
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure -- --stream
```

## Follow-up: remove idle pacing from backlog draining

The measurements above preceded the scheduler pacing fix. The real Backoffice CLI exposed its cost:
`listen org:wilcos-organization --base-url http://localhost:5173` took 22.773 seconds from stream
request to `caught-up` for only 3,792 entries / 3,007,809 response-body bytes (2.868 MiB). That was
approximately 76 pages paced at 300 ms, not a network bandwidth limit.

After the fix, the same local preview database and CLI transferred exactly the same entry count and
byte count in **343 ms** (about **66× faster**). First byte arrived in 21 ms, throughput was 8.35
MiB/s, and CLI startup through catch-up took 441 ms. The measurement counts protocol frames but
excludes HTTP headers; CLI entry-only output was 2,912,767 bytes. Output went to `/dev/null`, and
listening stopped after catch-up rather than counting idle listening time.

The hub now coalesces prompt scheduler refreshes after full pages or unserviced groups. Every pass
still yields to the event loop, serves live observers first, and budgets at most four catch-up
groups. Page size and item-wise write backpressure are unchanged. Idle polling and transient read
failure retries retain their 300 ms interval, and rapid draining does not flood idle clients with
heartbeats. Regression tests cover these guarantees and cancellation during a drain.

The heavy mixed smoke workload also passed after the change: 7.376 seconds, 60 measured outbox
reads, 250 MiB current-client payload, matching checksums, 11 control frames, and historical
progress of 22 / 1,020 entries. This is a correctness smoke comparison, not a controlled memory A/B.
Its first attempt exposed the benchmark cleanup helper's one-second retry cap racing sequential
stream cancellation; cleanup now allows the response lease to expire and retries only SQLite's
active-query error. The final run exited successfully.
