# Server-only outbox polling versus item-wise streaming

Date: September 24, 2026

This report supersedes the earlier in-process outbox comparison. That benchmark measured both the
route server and `fragment.callRoute()` client parser in one process. The corrected benchmark
profiles only the server process and drives it through localhost HTTP from an unmeasured child.

## Conclusion

Under a preloaded backlog and slow consumer, item-wise streaming substantially reduces server RSS
and external-memory pressure but does not reduce V8 heap. Across five alternating pairs, streaming
reduced median peak RSS by 23% and peak external memory by 70%, while median peak V8 heap was 3%
higher. Streaming also completed 19% faster.

Streaming sampled 41% more cumulative V8 allocation than polling. The additional allocations are
server-owned per-entry query-tree decoding, JSON serialization, byte encoding, and response writing.
The client parser is no longer present in these profiles.

The server-side result supports retaining item-wise streaming for bounded transport memory. It does
not support claiming that streaming lowers every server memory metric.

## Process boundary

The measured process:

- owns the real SQLite database and Fragno fragment;
- serves the fragment through `@fragno-dev/node` and `node:http`;
- records V8 allocation samples, V8 heap, RSS, and external memory.

A separate, unprofiled client process:

- connects over localhost HTTP;
- consumes the real `/_internal/outbox` or `/_internal/outbox/stream` route;
- validates each complete entry, payload length, and checksum;
- applies the 5 ms per-entry delay;
- holds the stream open after the last measured entry.

The client reports completion over IPC. The server stops memory sampling and allocation profiling
before instructing the client to cancel the stream. Client startup, cancellation, HTTP teardown, and
profile serialization are outside the measured workload.

## Workload

Every run used the same deterministic backlog:

- 1,000 complete outbox entries
- one mutation per entry
- 128 KiB string payload per mutation
- 125 MiB of payload consumed per run
- canonical 50-entry database page size
- 5 ms delay after each consumed entry
- 300 ms polling interval
- Node.js 26.10.0 with a 256 MiB server V8 heap
- 2 MiB SQLite page cache
- V8 allocation sampling every 128 KiB

Five pairs were run sequentially in alternating order:

1. poll, stream
2. stream, poll
3. poll, stream
4. stream, poll
5. poll, stream

All ten client runs consumed exactly 1,000 entries and 131,072,000 payload bytes with checksum
102,000.

## Aggregate results

Values are medians across five runs. Ranges show minimum to maximum.

| Metric                    |                          Poll |                          Stream | Stream difference |
| ------------------------- | ----------------------------: | ------------------------------: | ----------------: |
| Duration                  |      11.732 s (11.640–11.875) |          9.449 s (9.358–10.044) |            -19.5% |
| Throughput                | 85.24 entries/s (84.21–85.91) | 105.83 entries/s (99.56–106.87) |            +24.2% |
| Peak V8 heap              |          37.4 MiB (37.4–37.6) |            38.4 MiB (38.4–39.0) |             +2.7% |
| Peak V8 heap rise         |          21.2 MiB (21.2–21.3) |            22.2 MiB (22.2–22.7) |             +4.8% |
| Peak RSS                  |       206.9 MiB (194.6–209.0) |         159.2 MiB (158.5–162.4) |            -23.0% |
| Peak RSS rise             |          73.3 MiB (60.9–74.9) |            25.4 MiB (25.0–28.8) |            -65.4% |
| Peak external memory      |          37.8 MiB (37.8–44.1) |            11.3 MiB (11.3–11.3) |            -70.3% |
| Peak external-memory rise |          31.4 MiB (31.4–37.6) |               4.8 MiB (4.8–4.8) |            -84.8% |
| Retained V8 heap after GC |          16.9 MiB (16.9–16.9) |            18.5 MiB (18.4–18.5) |          +1.6 MiB |
| Retained RSS after GC     |       165.8 MiB (147.0–169.1) |         157.7 MiB (156.8–160.1) |             -4.9% |
| Sampled V8 allocations    |       470.3 MiB (459.9–477.2) |         664.6 MiB (652.2–681.4) |            +41.3% |

The memory directions were consistent in all five pairs: streaming always had slightly higher V8
heap and substantially lower RSS and external memory.

## Pair results

| Pair | Poll allocations | Stream allocations | Poll peak heap | Stream peak heap | Poll peak RSS | Stream peak RSS | Poll peak external | Stream peak external | Poll duration | Stream duration |
| ---: | ---------------: | -----------------: | -------------: | ---------------: | ------------: | --------------: | -----------------: | -------------------: | ------------: | --------------: |
|    1 |        473.8 MiB |          665.2 MiB |       37.4 MiB |         38.4 MiB |     194.6 MiB |       158.9 MiB |           37.8 MiB |             11.3 MiB |       11.83 s |         10.02 s |
|    2 |        477.2 MiB |          652.2 MiB |       37.4 MiB |         39.0 MiB |     209.0 MiB |       158.5 MiB |           44.1 MiB |             11.3 MiB |       11.88 s |         10.04 s |
|    3 |        470.3 MiB |          652.4 MiB |       37.6 MiB |         38.4 MiB |     196.3 MiB |       159.2 MiB |           37.8 MiB |             11.3 MiB |       11.72 s |          9.45 s |
|    4 |        461.4 MiB |          664.6 MiB |       37.4 MiB |         38.4 MiB |     207.2 MiB |       162.4 MiB |           37.8 MiB |             11.3 MiB |       11.73 s |          9.37 s |
|    5 |        459.9 MiB |          681.4 MiB |       37.4 MiB |         38.4 MiB |     206.9 MiB |       159.2 MiB |           37.8 MiB |             11.3 MiB |       11.64 s |          9.36 s |

## Server allocation attribution

### Buffered polling

| Project caller                              | Median sampled allocation |
| ------------------------------------------- | ------------------------: |
| Buffered SQLite query execution             |                 157.4 MiB |
| SQLite mutation JSON deserialization        |                 156.6 MiB |
| Complete-page `Response.json` serialization |                 125.9 MiB |
| Outbox entry assembly                       |                  14.4 MiB |

### Item-wise streaming

| Project caller                     | Median sampled allocation |
| ---------------------------------- | ------------------------: |
| Per-entry route JSON serialization |                 157.5 MiB |
| Streaming SQLite cursor iteration  |                 157.3 MiB |
| `writeRaw` byte encoding           |                 154.9 MiB |
| Nested child-array JSON parse      |                  97.8 MiB |
| Query-tree child decoding          |                  58.0 MiB |
| Outbox entry assembly              |                  14.1 MiB |

`parseNDJSONStream` and other client decoding paths are absent from the corrected profiles.

## Interpretation

Polling creates a complete 50-entry JSON response before Node HTTP can send it. With 128 KiB
payloads, one page contains 6.25 MiB before response strings, encoded bytes, adapter buffers, and
socket writes. These representations primarily appear in server external memory and RSS rather than
V8 heap.

Streaming still allocates a JSON string and encoded bytes for every entry, but backpressure bounds
how many frames can remain live in the server and HTTP transport. That lowers median peak external
memory by 26.6 MiB and peak RSS by 47.7 MiB.

The approximately 1 MiB higher peak V8 heap and 1.6 MiB higher retained V8 heap show that stream and
Node HTTP infrastructure have a modest fixed server cost. The benefit is bounded byte-buffer memory,
not lower JavaScript heap.

The 41% allocation premium is real server work, not client parsing. Reducing it further would
require larger changes such as streaming flat outbox/mutation rows instead of constructing a nested
SQLite JSON aggregate, or reducing string-to-byte copies across `writeRaw` and the Node adapter.
Neither is necessary to preserve the current peak-RSS benefit.

## Limitations

- Localhost HTTP includes sockets and the Node adapter but excludes TLS and proxy buffering.
- RSS includes SQLite, V8 reservations, native HTTP buffers, and allocator release behavior.
- Allocation profiles count collected objects and do not measure retained memory.
- Forced GC is diagnostic and does not represent ordinary production scheduling.
- The client process applies production-equivalent per-entry backpressure but is not itself
  profiled.
- The benchmark uses one payload shape, one page size, and one consumer delay.
- SQLite uses a deliberately bounded 2 MiB page cache to keep delivery memory visible.
