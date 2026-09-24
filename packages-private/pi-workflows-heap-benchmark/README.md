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

## Outbox backlog benchmark

The focused outbox benchmark preloads 1,000 complete entries with one 128 KiB mutation payload each.
The child consumes the real poll or stream route with the canonical 50-entry page size and a 5 ms
per-entry delay. This isolates server delivery behavior under backlog and backpressure.

```sh
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --profile
pnpm --filter @fragno-private/pi-workflows-heap-benchmark measure:outbox -- --stream --profile
```

Override the workload with `--entries COUNT`, `--payload-kib KIB`, or `--consumer-delay-ms MS`.
Profiled runs write an `outbox-*.heapprofile` and matching `outbox-*.benchmark-metrics.json`
sidecar. See `reports/2026-09-24-outbox-only-poll-vs-stream.md` for the five-pair server-only
baseline.

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
