# Opaque outbox payload streaming

Date: September 25, 2026

## Goal

Remove payload-sized JavaScript object reconstruction from the framed outbox stream while preserving
normalized mutation rows, cleanup/compaction semantics, bounded 50-entry reads, item-wise network
backpressure, and shared compatible deliveries.

## Design

The SQL stream still reads `fragno_db_outbox_mutations` rather than trusting the parent outbox row's
empty payload. This is required because cleanup deletes normalized mutation rows to remove transient
historical operations from later catch-up responses.

For each bounded parent entry, the SQL projection now aggregates its ordered mutation payloads as
JSON text and casts the aggregate plus reference map to text. The adapter:

1. scans only the aggregate's JSON container structure;
2. keeps each operation's `json` value as an opaque substring;
3. parses only the comparatively small SuperJSON `meta` object;
4. prefixes metadata paths with the final `operations.N` position;
5. assembles the wire entry JSON without constructing operation objects; and
6. passes that serialized entry to the observation hub, which frames and UTF-8 encodes it once for
   all compatible observers.

MySQL aggregates include a database ordinal because `JSON_ARRAYAGG` does not guarantee subquery
ordering. SQLite and PostgreSQL preserve the mutation-versionstamp order in the aggregate subquery.
The SQL result remains one row per outbox entry, preserving the Durable Object cursor guarantee that
a 50-entry page fits in one configured stream chunk.

The in-memory adapter retains the decoded reconstruction path because its native store owns objects,
not serialized SQL JSON.

## Workload

Three fresh profiled runs used the same mixed workload as the shared-frame comparison:

- two current clients at the live tail;
- two divergent historical clients (`limit=1` and `limit=50`);
- 1,000 historical and 1,000 measured entries;
- one 128 KiB mutation payload per entry;
- 5 ms client delay;
- 250 MiB delivered to current clients;
- 60 measured SQLite outbox reads.

The baseline is the three-run shared-frame median recorded in the open heap report. It already
encoded each compatible delivery once but still parsed query-tree child JSON and reserialized the
operations.

## Results

| Metric               | Shared-frame baseline median | Opaque-payload median |               Change |
| -------------------- | ---------------------------: | --------------------: | -------------------: |
| Sampled allocation   |                  1,690.1 MiB |           1,011.7 MiB |  -678.4 MiB (-40.1%) |
| Natural-GC heap rise |                    42.93 MiB |             21.76 MiB |  -21.17 MiB (-49.3%) |
| External-memory rise |                    10.40 MiB |             10.89 MiB |    +0.49 MiB (+4.7%) |
| Duration             |                      8.032 s |               8.414 s |     +0.382 s (+4.8%) |
| Retained heap rise   |                  no increase |             -0.93 MiB | no retained increase |
| SQLite outbox reads  |                           60 |                    60 |            unchanged |

All current clients consumed 1,000 entries with the same checksum. The `limit=1` historical client
consumed 22 entries in every candidate run; the midpoint client consumed 1,013–1,016 entries before
the measured workload completed.

The candidate allocation samples were 1,001.1, 1,033.8, and 1,011.7 MiB. Heap-rise samples were
21.40, 21.76, and 30.96 MiB; the third run shows that natural-GC timing still varies even though the
median and cumulative allocation fell substantially.

## Allocation ownership after the change

The median candidate's dominant payload-sized allocations are now:

- SQLite/Kysely raw row materialization: approximately 324 MiB;
- one shared UTF-8 frame encoding: approximately 314 MiB;
- benchmark-side payload creation/insertion: approximately 313 MiB.

Query-tree `parseJsonValue`, `decodeChildNode`, outbox operation deserialization, and
`assembleOutboxEntry` no longer appear as payload-sized stream allocators. Fragno DB exclusive
allocation fell to approximately 18 MiB in the representative candidate profile;
`assembleSerializedOutboxStreamEntry` owned approximately 2.6 MiB.

The remaining large delivery allocations are the raw SQLite result string and the encoded response
bytes. The benchmark-side insertion allocation is setup/workload generation in the measured server,
not stream retrieval.

## Conclusion

Keeping normalized mutation payloads opaque removes the leading avoidable delivery representation.
It cuts sampled allocation by 40.1% and the three-run median natural-GC heap rise by 49.3% without
changing database read count, cursor semantics, checksums, compaction behavior, or retained heap.
The next workflow-specific target remains the runner's instance-wide historical emission retrieval.
