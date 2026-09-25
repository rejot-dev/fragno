# Pi + Workflows server heap benchmarks

Both benchmarks use the same process boundary:

- the measured parent process owns SQLite, Fragno, the Node HTTP server, memory sampling, and V8
  allocation profiling;
- an unmeasured child process drives the workload over localhost HTTP and reports completion over
  IPC;
- profiling stops before client cancellation and transport teardown;
- retained server memory is measured after the client exits and three forced garbage collections.

Localhost HTTP includes the Fragno Node adapter, sockets, and transport buffering. It excludes TLS,
proxies, and client parsing memory.

The repository pins Node.js 26.10.0 in its root `.node-version`. Use that runtime before installing
dependencies or running a benchmark so the native `better-sqlite3` binding matches the measured
process.

## Pi workflow benchmark

The Pi workflow benchmark runs a real interactive chat workflow backed by temporary SQLite. The
server replays the checked-in 80-stanza assistant trace from `fixtures/poem-assistant-stream.json`.
Poll and stream runs therefore receive the same provider events without API calls or model charges.
The default 4× replay finishes in roughly 15 seconds.

The child process establishes the pre-run outbox cursor, consumes either `/_internal/outbox` or
`/_internal/outbox/stream`, submits the command, waits through the command completion route, and
reads final workflow status over HTTP. Setup and cursor acquisition finish before server memory
measurement begins.

```sh
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure -- --stream
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure -- --profile
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure -- --stream --profile
```

Use `--replay-speed 2` or another positive factor to change replay pacing. Profiled runs write a
`pi-workflow-*.heapprofile` and matching `pi-workflow-*.benchmark-metrics.json` sidecar.

### Refresh the recorded assistant trace

Refreshing is the only operation that calls a model and incurs charges. Copy `.env.example` to
`.env`, configure a key, then run:

```sh
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure -- --capture --provider openai --model gpt-5.6-luna
```

`--capture` runs the server benchmark through the selected provider and replaces the fixture with
compact event deltas, inter-event timing, message metadata, and the terminal response. Without an
explicit provider, capture selects the first configured provider in this order: OpenAI, Anthropic,
Google.

## Outbox benchmark

The focused outbox benchmark preloads 1,000 complete entries with one 128 KiB mutation payload each.
The child consumes the real poll or stream route with the canonical 50-entry page size and a 5 ms
per-entry delay. This isolates server delivery behavior under backlog and backpressure.

```sh
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --profile
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --stream --profile
```

Override the workload with `--entries COUNT`, `--history-entries COUNT`, `--payload-kib KIB`,
`--consumer-delay-ms MS`, `--clients COUNT`, or `--lagging-clients COUNT`. Concurrent clients use
separate HTTP responses against the same fragment and database adapter. The result reports aggregate
throughput and payload bytes, the slowest client duration, and the number of SQLite outbox reads
observed during the measured workload. Every client must consume the same payload bytes and
checksum. Stream clients request `protocol=1`, count/checksum only `entry` frames, and reconnect
immediately after `rotate`. `controlFramesConsumed` separately counts control frames across current
and lagging clients, including connection preparation; it is not a measured-window-only counter.
Legacy sidecars without that field default it to zero.

Because entries are preloaded before clients connect, ordinary multi-client stream runs measure
catch-up isolation and compatible catch-up grouping rather than steady-state shared live polling.
Pass `--live` with `--stream` to preload historical entries, connect current clients at the tail
plus historical catch-up clients, wait for every current client's explicit `caught-up` marker, reset
measured SQL reads, and then append the measured entries. Heartbeats no longer establish readiness.
Lagging clients receive evenly spaced historical cursors: the first uses `limit=1` and subsequent
clients use 50-entry pages. Override the default one lagging client with `--lagging-clients COUNT`
and the default 100-entry history with `--history-entries COUNT`.

For low-bandwidth catch-up and live-tail scaling runs:

```sh
# Catch-up workload
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --stream --clients 10 --entries 1000 --payload-kib 1 --consumer-delay-ms 1

# Shared live poll plus one active historical limit=1 observer
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --stream --live --clients 1 --entries 1000 --history-entries 100 --payload-kib 1 --consumer-delay-ms 1
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --stream --live --clients 10 --entries 1000 --history-entries 100 --payload-kib 1 --consumer-delay-ms 1

# Two current clients plus divergent origin/limit=1 and midpoint/limit=50 catch-up clients
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --stream --live --clients 2 --lagging-clients 2 --entries 1000 --history-entries 1000 --payload-kib 128 --consumer-delay-ms 5
```

Profiled runs write an `outbox-*.heapprofile` and matching `outbox-*.benchmark-metrics.json`
sidecar. See `reports/2026-09-24-outbox-only-poll-vs-stream.md` for the five-pair server-only
poll-versus-stream baseline and `reports/2026-09-25-shared-outbox-observation.md` for concurrent
client scaling.

## Analyze server profiles

The analyzer resolves generated frames through source maps and reports exclusive allocators,
project-owned callers, inclusive project frames, and project-to-allocator paths.

```sh
pnpm --filter @fragno-private/pi-workflows-heap-benchmark analyze -- report pi-workflow-poll-EXAMPLE.heapprofile
pnpm --filter @fragno-private/pi-workflows-heap-benchmark analyze -- compare pi-workflow-poll-EXAMPLE.heapprofile pi-workflow-stream-EXAMPLE.heapprofile
```

The analyzer automatically reads the adjacent `.benchmark-metrics.json` sidecar. Pass `--json` for
machine-readable output or use `--metrics`, `--baseline-metrics`, and `--candidate-metrics` to
select sidecars explicitly. It rejects comparisons across different process boundaries or workload
identities.

Allocation profiles count collected objects and are not retained-heap snapshots. The sidecar records
a 10 ms timeline for V8 heap, RSS, and external memory, plus post-teardown retained server memory.
RSS includes SQLite, V8 reservations, native HTTP buffers, and allocator behavior that V8 profiles
do not capture.

## Source layout

- `src/workflow/` — Pi workflow benchmark server, HTTP client, protocol, configuration, and replay
  provider
- `src/outbox/` — focused outbox benchmark server, HTTP client, protocol, and configuration
- `src/heap-profile/` — allocation-profile analysis and source-map resolution
- `src/benchmark-runtime/` — shared server memory, metrics, and child-process primitives
