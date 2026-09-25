# Streaming Pi output causes excessive transient heap allocation

Status: open

Created: September 2, 2026

Last updated: September 25, 2026

## Goal

Reduce peak heap usage while a Pi agent streams a long response and clients consume the Automations
outbox. **The primary success criterion is a lower natural-GC peak in a production-preview heap-only
run of comparable output, without explicit GC during the turn.** Lower cumulative sampled
allocation, settled heap, or SQL duration alone does not resolve this issue.

The target is not merely to make garbage collection recover the heap after the turn. The amount of
live and transient work performed by each flush must remain bounded as the persisted emission
history grows. A response twice as long must not make every later pump pass retrieve, decode, copy,
and walk twice as much historical state.

## Summary

The original September 2 long-response run produced a 31,412-character assistant message, 691
Automations outbox entries, and 6.6 MB of NDJSON. The worker allocated approximately 5.95 GB during
the 120-second allocation-sampling window, although most of that memory was short-lived.

At the time, the primary allocation source was not writing NDJSON to the HTTP response. It was the
Workflows step live pump rebuilding the complete workflow emission projection every 100 ms:

```text
streaming model event
  -> Pi harness event encoding
  -> workflow step emission flush every 100 ms
     -> retrieve every persisted emission, step, and event for the instance
     -> decode every row
     -> recompute canonical emissions
     -> map every canonical row to observedItems
     -> walk every observed item again for cursor deduplication
  -> persist new outbox mutations
  -> each connected outbox stream polls and serializes the new entries
```

As the response grows, each pass processes more history. This creates approximately quadratic
cumulative allocation over a long streamed response and raises peak heap pressure even though a
later full GC releases most of it.

Two additional amplifiers were observed:

1. Each outbox HTTP client owns an independent 300 ms database polling loop. Multiple browser and
   CLI streams duplicate that work.
2. In the earlier instrumented builds, local debugger console entries retained structured SQL
   query-metric objects and generated SQL strings until Wrangler reloaded the worker or
   `Runtime.discardConsoleEntries` was called. Backoffice no longer enables that instrumentation.

## Current status

**Executive summary (September 25):** The original full-history user-emission pump and cumulative Pi
encoder paths are fixed, and Backoffice SQL query-metric instrumentation is disabled. Compiler
reuse, narrow `INSERT RETURNING`, batched outbox inserts, and 100-emission durable cleanup pages are
in the current worktree. They reduce measured cumulative allocation or bound individual cleanup
attempts, but **no completed, comparable heap-only run of the current build establishes a lower
natural-GC peak**. The first preview after disabling SQL instrumentation failed to finish cleanup;
it has no valid peak result. A September 25 cleanup-only Workerd comparison now proves that the
100-row hook boundary does not bound cumulative cleanup allocation or natural-GC peak across a long
durable chain. Bounded bulk deletes now materially reduce that work, but the long-history peak still
grows. Prioritize the remaining per-page cleanup overhead and a completed comparable-output preview,
then verify retry-safe cleanup and long Pi waits. The September 22–23 numbers below describe
historical, differently instrumented dirty worktrees, not a single current-binary A/B.

### Resolved

The current worktree resolves the two original quadratic-allocation paths:

- The workflow live pump no longer retrieves, decodes, canonicalizes, and delivers the complete
  persisted user-emission history on every 100 ms pass. It still retrieves persisted system
  controls. The isolated benchmark increased history from 100 to 10,000 user emissions and measured
  only 21% more sampled allocation with almost unchanged duration.
- The Pi event encoder updates common text, thinking, and tool-call deltas incrementally. All
  isolated encoder and decoder growth checks passed the configured linear-growth limit.
- Production-preview measurement is now reproducible. Vite development mode is excluded because its
  `ModuleRunner` retained approximately 282 MiB of transformed source and inline source maps.
- Backoffice configures `queryInstrumentation: null`, so it no longer collects or logs SQL query
  metrics on the request path. The Durable Object dialect retains an opt-in callback but skips
  row-read counters, timing, and metrics-object construction when disabled.

These changes reduced the production-preview workload from approximately 5.95 GB to 1.151 GB of
sampled allocation, approximately 80.7% overall and 76.2% per output character. Post-GC and settled
absolute heap are also below the September 2 run.

### Peak JS heap cause: collectible transient allocations accumulate before GC

A heap-only preview run without allocation sampling still peaked at **110.38 MiB**, close to the
sampled run's 110.73 MiB. Cleanup had finished about 34 seconds before that peak, which then fell in
two approximately 24 and 25 MiB steps without explicit GC. Allocation sampling and a large
continuously live cleanup object graph are not sufficient explanations.

A controlled follow-up used the same long prompt and produced 31,075 assistant characters (versus
31,412 on September 2). After 45 seconds of streaming, GC recovered **8.00 MB**. At 88.6 seconds,
_while cleanup SQL was still executing_, GC dropped used heap from **99.69 MB to 58.10 MB**: **41.59
MB immediately collectible**. After another 35 seconds with the listener attached, only 2.24 MB was
recovered by GC; discarding debugger console entries and collecting again recovered another 4.88 MB.
An idle listener with no turn rose only 5.16 MB in 50 seconds before GC.

**Conclusion:** the elevated `usedSize` peak is primarily short-lived objects accumulated during the
workload and left uncollected until GC runs, not a retained leak. The streaming workflow and
persistence/serialization path are substantial allocators. Terminal cleanup can also produce
garbage, but its share of the peak has not been quantified. The existing allocation profile
identifies SuperJSON traversal, SQL execution/query construction, and SSE parsing as substantial
cumulative allocators; it does not identify the exact per-phase contribution to the instantaneous
peak. Do not use periodic forced GC as a product fix.

### Separate high-priority issue: terminal cleanup SQL and payload scaling

Earlier `onWorkflowStepEmissionsCleanup` retrieved the full matching emission/outbox-mutation set,
queued every delete, and emitted one truncate containing 5,884–7,568 IDs; cleanup storage operations
took up to 21.045 seconds. The current worktree processes at most **100 emissions per durable
hook**, commits a bounded truncate with each page, and durably schedules the next page in the same
transaction. In two comparable-size preview checks, the complete cleanup took 4.56–4.67 seconds and
one run's longest observed SQLite transaction took 51 ms. The cleanup still issues individual
checked deletes, total work scales with history, and the separate natural-GC peak goal is **not**
resolved.

### Follow-up: phase allocation and SQL-log control

A further production-preview heap-only run with 26,997 assistant characters peaked at **117.99
MiB**. In the matching-binary sampled run (29,732 characters), the window labeled streaming
attributed approximately **37%** of sampled allocation to query compilation and **30%** to outbox
insertion/result serialization. The sampler switch lagged the cleanup marker and included some
cleanup DELETE compilation, so these are **not reliable streaming-only percentages**; its 99.72 MiB
sampled peak is **not** comparable to the unsampled absolute peak. In the log-enabled cleanup
traces, 6,518–7,450 structured SQL query-metric console calls accompanied 6.3–7.1 MB of preview
output and a 9.54–19.61-second storage execution/transaction. Two diagnostic no-SQL-log runs still
peaked at **93.63–107.30 MiB** with shorter (20,536–21,991 character) responses. The lower peaks
cannot be attributed to log suppression without matched output and GC behavior.

The profiler's cleanup-completed marker observes **callback return**, not the end of the storage
transaction: traces continued for up to another 19.61 seconds. Its zero sampled allocation for the
subsecond callback window does **not** prove cleanup was allocation-free. Use trace end times when
assigning phase-specific work. Query compilation/serialization is the main measured streaming
allocation opportunity; high-volume SQL logging and whole-history cleanup are independently proven
amplifiers.

### Scoped SQL compiler A/B

Two production-preview heap-only turns per compiler variant, with the same prompt/model and
length-nearest outputs of 37,392–38,286 and 28,821–30,987 characters, gave **opposite peak-heap
comparisons**. The working-tree compiler cache did not demonstrate a repeatable natural-GC peak
reduction. In a separate fixed-emission workflow, three allocation samples per variant showed
**17–26% less cumulative allocation** with the cache, while heap-only peak changes went in opposite
directions for short versus long histories. Keep the allocation improvement and the unresolved peak
goal distinct. The fixed-workload A/B results remain useful for evaluating allocation, not peak.

### Narrow RETURNING, outbox batching, and durable cleanup

Compiler `INSERT` statements now return only the internal ID; normalized outbox mutations insert in
chunks of at most ten rows; terminal cleanup processes at most 100 emissions per durable hook with
atomic continuation and bounded truncate IDs. SQLite/PGlite tests, a real-SQLite 207-row
cleanup-and-restart scenario, and a 6,000-emission Workerd run pass. The final cleanup design cut
comparable-size preview cleanup wall time from roughly 11 seconds with in-hook paging to roughly 4.6
seconds, **but** its fixed-workload natural-GC peak rose 0.80 MiB with 100 historical rows and 4.80
MiB with 10,000, relative to in-hook paging. Two combined preview turns of 28,691 and 29,157
characters peaked at 116.57 and 118.10 MiB. Individual preview A/B attribution and a repeatable peak
improvement have not been established. The earlier artifact's 32.45-second cleanup-duration field
was wrong: it measured an outer alarm span rather than the delete-bearing storage transactions;
marker-to-marker wall time was approximately 4.67 seconds.

### Backoffice SQL-metric collector removed; cleanup reads narrowed

An intermediate bounded SQL logger reduced console events **21,198 → 1,864** across two preview
turns, but the output lengths differed and peak-heap savings were not established. Even its bounded
windows still emitted events proportional to heavy workload. The current worktree **removes the
Backoffice SQL collector** and configures the dialect's supported query-instrumentation callback as
`null`, skipping per-query measurements. Those intermediate A/B measurements do not describe the
current build's console behavior. A post-removal preview attempt on September 23 emitted **zero
SQL-metric events**, but its Workerd alarm exceeded its execution limit and cleanup markers never
arrived; it yielded **no valid peak-heap result**
(`/tmp/p12-streaming-query-metrics-disabled-2026-09-23.json`).

The workflow cleanup hook now retrieves only IDs and index fields needed for pagination, rather than
decoding emission payloads. In three fresh-process fixed Workerd runs with 300 new emissions of 8
KiB each, median natural-GC peak fell **21.54 → 18.90 MiB** (2.64 MiB, 12.3%). The real-SQLite
restart/cleanup scenario still verifies all 207 rows, truncated IDs, and outbox-mutation state. The
29,106-character post-projection preview peaked at 115.36 MiB, between two 28,795–28,845-character
logging-only peaks of 110.63 and 116.31 MiB. Other post-projection turns varied more in length; **a
lower Backoffice natural-GC peak remains unproven**.

### September 25 cleanup isolation and current allocation ranking

The Workerd workflow benchmark now has a cleanup-only mode. It seeds one exact step/epoch target,
schedules the real `onWorkflowStepEmissionsCleanup` hook, and invokes one durable-hook alarm per
request. Three fresh-process runs compared 100 and 10,000 matching emissions with 256-byte payloads
and production query instrumentation disabled:

| Cleanup rows | Median peak delta | Median sampled allocation | Median duration |
| -----------: | ----------------: | ------------------------: | --------------: |
|          100 |          0.53 MiB |                  3.56 MiB |         0.333 s |
|       10,000 |         35.58 MiB |                270.31 MiB |         5.917 s |

The 100-row page bounds each hook's retrieval and truncate list, but the chain still accumulates
short-lived mutation/query objects faster than natural GC collects them. A separate diagnostic run
with query instrumentation enabled only for SQL counting observed 219 statements for 100 rows and
21,702 for 10,000 rows. The long case contained 20,000 `DELETE` statements: one checked emission
delete and one outbox-mutation delete per row. No individual statement exceeded 1 ms in that run;
the problem is statement and object count, not one unbounded SQL statement.

A one-emission streaming control isolated the remaining history-sensitive runner read. Increasing
unrelated persisted emissions from zero to 10,000 raised median sampled allocation from 3.40 to
12.54 MiB and median peak delta from 1.07 to 4.34 MiB. The added allocation was dominated by SQLite
result materialization and Fragno row decoding. `runWorkflowsTick` still retrieves every
`workflow_step_emission` for the instance, even though the live pump itself now reads only system
controls.

The current deterministic 4× recorded Pi stream produced 4,270 user emissions, cleaned them in 43
pages, and sampled 1,099.9 MiB of server allocation with a 38.6 MiB heap rise. Excluding the
recorded provider's benchmark-only message construction, the largest owners were outbox mutation
serialization/insertion, outbox entry assembly, query compilation, and terminal delete compilation:

- SuperJSON: 264.5 MiB exclusive;
- Fragno DB: 211.2 MiB exclusive;
- Kysely: 199.7 MiB exclusive;
- outbox mutation insertion: 165.5 MiB nearest-project ownership;
- outbox entry assembly: 146.5 MiB nearest-project ownership;
- query-tree compilation: 75.0 MiB nearest-project ownership;
- delete compilation: 66.5 MiB nearest-project ownership.

The existing mixed outbox profile remains a separate payload-copying result: 1,712.9 MiB sampled
allocation while delivering 250 MiB to two current clients plus two lagging clients, with a 33.4 MiB
peak rise and no retained-heap increase after teardown. Its dominant avoidable work is raw SQLite
row materialization followed by query-tree JSON parsing/decoding before framing; response UTF-8
encoding is unavoidable but currently follows those extra representations. The Pi event encoder
regression still scales linearly, with normalized allocation growth between 0.90× and 1.03×, so it
is not the next target.

The bounded bulk-delete implementation was then measured with the same three-run cleanup workload:

| Cleanup rows | Peak before → after | Allocation before → after | Heap duration before → after |
| -----------: | ------------------: | ------------------------: | ---------------------------: |
|          100 |     0.53 → 0.00 MiB |           3.56 → 1.31 MiB |              0.333 → 0.290 s |
|       10,000 |   35.58 → 19.80 MiB |        270.31 → 91.30 MiB |              5.917 → 1.672 s |

`deleteMany` preserves per-row optimistic concurrency checks and compiles common-version rows as
`version = ? AND id IN (...)`. The Durable Object driver advertises its 100-bind limit, so each
100-row emission page compiles into checked chunks of 99 and one row; the 100 normalized outbox
mutation IDs use one unchecked statement. The 10,000-row case therefore performs 300 deletion
statements by construction instead of 20,000. The real Workerd cleanup completed, and adapter tests
verify that a stale row rolls the entire bulk transaction back.

This is a substantial improvement, but it does **not** satisfy the bounded-peak criterion: the
10,000-row natural-GC peak still rose 19.80 MiB and sampled allocation remained 91.30 MiB. The
remaining work is dominated by per-page retrieval, durable-hook continuation, truncate/outbox
construction, query execution, and transaction scaffolding repeated across 100 pages.

Recommended implementation order from here:

1. Encode each shared outbox frame once and pass the same immutable `Uint8Array` to compatible
   observers. `ResponseStream.writeRaw` already accepts bytes; the hub currently passes a string to
   every observer, causing one UTF-8 allocation per response.
2. Keep serialized outbox payloads opaque through retrieval and framing. The current stream query
   materializes SQLite JSON, query-tree decoding parses it, and framing serializes it again. A raw
   serialized payload path should bypass query-tree child decoding while retaining normalized
   mutation rows for cleanup/compaction.
3. Narrow the runner's instance-wide emission retrieval. At minimum, avoid decoding stale user
   payloads that cannot participate in the current replay; preserve system controls and active-step
   replay semantics.

Do not start by increasing cleanup page size or forcing GC. Page size only trades hook overhead for
larger individual transactions, while forced GC hides rather than removes the measured allocation.

### Measurement provenance and limits

The September 22 full-app rerun used the Vite development server. Its approximately 334 MiB baseline
was mostly development tooling: a heap snapshot attributed 281.84 MiB of 297.08 MiB self size to
transformed source and inline source maps. **Do not compare that baseline to product heap.** Its
isolated history and protocol benchmarks remain relevant.

The September 23 production-preview rerun started at 46.17 MiB, peaked at 110.73 MiB during a
sampled 120-second workload, fell to 54.56 MiB after GC, and settled at 50.45 MiB after console
discard and another GC. It sampled 1.151 GB, approximately 80.7% less cumulative allocation than
September 2 and approximately 76.2% less per output character, but its absolute peak was higher. A
separate heap-only preview peaked at 110.38 MiB without allocation sampling. Its peak was about 34
seconds _after_ cleanup ended; later spontaneous GC drops and the controlled GC checkpoints show
collectible garbage, not a proven continuously live cleanup object graph. One idle listener alone
added at most 5.16 MB before GC in 50 seconds.

Model output, listener attachment, SQL-logging mode, dirty-worktree code, GC timing, and sampled
versus heap-only instrumentation differed across subsequent runs. Sampled allocation measures
cumulative bytes, not simultaneous live heap. An outbox `truncate` or cleanup callback log is not
proof that its storage trace has finished. The September 23 post-removal preview failed with an
alarm execution-time error and no cleanup markers; it cannot be counted as a peak measurement.
Storage-operation volume, including per-emission persistence and repeated system-control queries,
remains a separate scaling concern. On September 24, source and available local JSON manifests were
checked, and 157 focused tests passed (12 workflow, 93 DB, 52 Pi); this is not a new model-backed
peak measurement. Raw local profiles and `/tmp` JSON manifests are disposable; use the benchmark
scripts below for reproducible future evidence.

## Fast reproduction procedure

### 1. Build and use preview mode

Always measure the production Worker bundles through Vite preview. Do not use `pnpm dev` or
`react-router dev` for absolute heap measurements: the development `ModuleRunner` retains
transformed module source, compiled script source, and inline base64 source maps.

From the repository root:

```bash
pnpm exec turbo run build \
  --filter=@fragno-apps/backoffice-rr \
  --output-logs=errors-only

pnpm --filter @fragno-apps/backoffice-rr preview
```

Preview serves Backoffice at `http://localhost:5173`, loads local secrets from the generated
`.dev.vars` files, and exposes the Workerd inspector at `http://localhost:9229`.

Verify the server and inspector before doing any expensive work:

```bash
curl -fsS http://localhost:5173/ >/dev/null
node scripts/workerd-cdp.mjs list
node scripts/workerd-cdp.mjs send rejot-backoffice Runtime.getHeapUsage
```

A fresh preview baseline should be approximately 45–65 MiB. The September 23 verification measured
50,802,532 bytes, or 48.4 MiB. If a fresh baseline exceeds 100 MiB, stop and resolve the measurement
environment before starting a model turn. Confirm that no old dev or preview process still owns
ports `5173` or `9229`.

### 2. Run the isolated regressions first

These runs are faster and cheaper than a model-backed turn. Do not continue to the full workload if
they fail.

```bash
pnpm --filter @fragno-private/workflows-heap-benchmark measure -- \
  --mode both \
  --histories 100,10000 \
  --runs 3 \
  --batch-count 30 \
  --emissions-per-batch 10 \
  --payload-bytes 256 \
  --interval-ms 125 \
  --json /tmp/workflows-heap-benchmark-current.json

pnpm --filter @fragno-dev/pi-harness measure:event-encoder -- \
  --json /tmp/pi-event-encoder-current.json
```

Use one-run quick modes while iterating. Use the three-run commands above for a result recorded in
this issue.

### 3. Prepare the authenticated full workload

Verify the stored CLI credential before opening streams or starting profiling:

```bash
BACKOFFICE_URL=http://localhost:5173 \
  pnpm --filter @rejot-dev/backoffice-cli run backoffice-cli doctor
```

If authentication has expired, run `backoffice-cli login --force --open` once. Create a fresh Pi
session for each recorded run and record its session ID. Read the current Automations outbox
versionstamp for the selected scope, then start exactly one listener from that cursor:

```bash
BACKOFFICE_URL=http://localhost:5173 \
  pnpm --filter @rejot-dev/backoffice-cli run backoffice-cli listen \
  org:wilcos-organization \
  --after-versionstamp <current-versionstamp> \
  > /tmp/backoffice-outbox-live.ndjson \
  2> /tmp/backoffice-outbox-live.stderr
```

Using a current cursor avoids replaying historical outbox entries into the measurement. Use two
listeners only when explicitly testing shared outbox ownership.

### 4. Profile through one CDP connection

Use one long-lived CDP client per run. **Run heap-only and sampled turns separately**; the latter
ranks cumulative allocation sites and does not provide the authoritative peak.

Before each turn:

1. enable `Runtime` and `HeapProfiler`;
2. call `Runtime.discardConsoleEntries`;
3. call `HeapProfiler.collectGarbage` with a timeout longer than 30 seconds;
4. wait briefly, then record `Runtime.getHeapUsage`;
5. start allocation sampling with a 32 KiB interval and collected minor/major objects included
   **only for the sampled turn**;
6. poll `Runtime.getHeapUsage` every 100 ms.

For current A/B runs, use the bounded 150-stanza prompt and the
[`benchmark:streaming-heap`](../scripts/benchmark-streaming-heap.md) harness (300-second codemode
limit, shorter Pi waiter, and a cleanup-marker deadline). Prefer its repeated heap-only runs and
separate sampled run over a fixed 120-second allocation window: do not stop measuring before the
final cleanup storage transaction ends. Failed runs or missing markers do not yield valid peaks.
Verify completion afterward with `pi.getSession`.

At the end:

1. record heap usage after the final cleanup storage transaction completes;
2. stop and save the allocation profile if sampling was enabled;
3. force GC and record heap usage;
4. discard console entries, force GC again, and record settled heap usage;
5. stop the outbox listener;
6. record NDJSON line count, byte count, and final versionstamp.

Do not take heap snapshots inside the allocation-sampling window. Snapshot creation and allocation
sampling both materially distort Workerd RSS.

### 5. Capture trace evidence last

After the turn, identify the causally contiguous workflow **and cleanup** traces in the workload
time window (durable-hook context may not propagate) and record:

- full trace ID and wall time;
- total spans;
- `durable_object_storage_exec` and transaction counts;
- rows read for the workflow system-emission query;
- outbox stream-list span and poll counts;
- durable-hook propagation state.

Keep the preview server running while querying Local Explorer. Stop it before directly mutating or
cleaning the trace SQLite database.

### 6. Store consistently named artifacts

Use stable `/tmp` names so comparison scripts and follow-up reports do not need discovery logic:

```text
/tmp/outbox-live-allocation-profile.json
/tmp/outbox-live-memory.tsv
/tmp/backoffice-outbox-live.ndjson
/tmp/backoffice-outbox-live.stderr
/tmp/pi-session-after-long-turn.json
/tmp/workflows-heap-benchmark-current.json
/tmp/pi-event-encoder-current.json
```

Record the Git commit, dirty-worktree state, Node version, pnpm version, Wrangler version, model,
session ID, trace ID, and exact commands in the follow-up report.

## How the investigation was conducted

### Workload

The authenticated Backoffice CLI was used against `http://localhost:5173`.

A scoped Automations outbox listener was started in the background and redirected to a file:

```bash
pnpm --filter @rejot-dev/backoffice-cli run backoffice-cli listen \
  org:wilcos-organization \
  --after-versionstamp 00000000000000000bd60000 \
  > /tmp/backoffice-outbox-live.ndjson
```

Codemode then sent this prompt to an existing Pi session:

```text
Write a very long poem. Make it at least 150 substantial stanzas, rich in imagery and narrative,
and continue until you have used as much of your available response as possible.
```

`pi.runTurn` returned a 408 because its internal `wait-for-agent-end` request is fixed at 60
seconds. The agent continued running and completed afterward. A later `pi.getSession` showed two
messages and a 31,412-character assistant response.

The outbox listener received:

- 691 NDJSON records;
- 6,615,808 bytes;
- mutations through versionstamp `00000000000000000e890000`.

### Memory tools

The Workerd inspector exposed Chrome DevTools Protocol 1.3 at
`ws://localhost:9229/rejot-backoffice`. `scripts/workerd-cdp.mjs` was used for:

- `Runtime.getHeapUsage`;
- `HeapProfiler.takeHeapSnapshot`;
- `HeapProfiler.startSampling` and `HeapProfiler.stopSampling`;
- `HeapProfiler.collectGarbage`;
- `Runtime.discardConsoleEntries`.

Heap snapshots were captured before the workload and after the completed workload plus an explicit
GC. Small Node scripts parsed the V8 heap snapshot node and edge tables to compare self sizes,
object counts, and incoming retainer edges. The allocation profile was aggregated by call frame and
full stack.

Process RSS was sampled with `ps`, but it is not the authoritative peak-heap measurement. Allocation
sampling and heap snapshots materially increased Workerd RSS themselves. At one point RSS reached
approximately 1.26 GB while the allocation profiler was retaining sampling metadata, then fell after
sampling stopped. That value must not be treated as the product's uninstrumented peak.

### Trace tools

The Cloudflare Local Explorer read-only SQL endpoint was queried at:

```text
POST /cdn-cgi/local/explorer/api/local/observability/query
```

Queries reconstructed the long-running workflow trace, grouped repeated spans, counted outbox poll
traces, and inspected `fragno.outbox_stream.completed` logs.

The representative workload trace was:

```text
e7d69ef6b88632e8887f61ffc6dca367
```

It covered 99.452 seconds and contained 20,854 spans:

- 19,378 `durable_object_storage_exec` spans;
- 1,392 `durable_object_storage_transaction` spans;
- two `fragno.durable_hook.attempt` spans;
- no propagation context on either durable-hook attempt.

The local observability database was also measured directly under
`apps/backoffice/.wrangler/state/v3/observability/miniflare-wobs-trace-store/`.

## Observed heap behavior

The worker's JS heap measurements were:

| Point                                                    |             Used heap |
| -------------------------------------------------------- | --------------------: |
| Idle/before workload                                     | approximately 56.6 MB |
| After the workload, before forced GC                     | approximately 95.4 MB |
| After forced GC                                          | approximately 62.0 MB |
| After discarding debugger console entries and forcing GC | approximately 56.7 MB |

This shows substantial transient pressure rather than a retained 5.95 GB leak. It also shows that
console retention accounted for approximately 8 MB of otherwise collectible heap in this run.

The post-workload heap snapshot had approximately 18.7 MB more self size than the pre-workload
snapshot. Important growth included:

- approximately 9.6 MB of native `JSArrayBufferData`;
- repeated compiled SQL strings for workflow emission queries and mutations;
- JIT instruction and feedback data created by the hot workload;
- objects retained through DevTools console handles.

## Allocation profile

The 120-second profile included objects collected by both minor and major GC. It sampled
approximately 5.95 GB of cumulative allocation.

Largest individual allocation sites:

| Allocation site                                      | Sampled allocation |
| ---------------------------------------------------- | -----------------: |
| Durable Object SQLite `executeQuery`                 |            1.04 GB |
| Fragno result `decodeResult`                         |           612.9 MB |
| Fragno value `deserialize`                           |           572.3 MB |
| `BufferedDatabasePump.#deliverObserved`              |           309.0 MB |
| Result-set row mapping                               |           271.2 MB |
| Additional `executeQuery` paths                      |           299.5 MB |
| Pi compact event prefix comparison                   |           177.4 MB |
| Workflow emission flush mapping and canonicalization |   more than 200 MB |
| Outbox `writeRaw`                                    |            16.1 MB |

Grouped stacks overlapped, but they establish relative ownership:

- database query, result decoding, and transaction paths accounted for approximately 2.98 GB;
- Pi stream and workflow-emission paths accounted for approximately 481 MB;
- outbox-specific persistence, polling, and response-writing paths accounted for approximately 332
  MB.

The direct HTTP write was not the dominant allocator.

## Original primary cause — resolved: full-history workflow emission flushes

`packages/fragment-workflows/src/runner/step-live-pump.ts` runs the workflow step emission pump
every 100 ms.

`writeWorkflowStepEmissionFlush` retrieves the complete instance state on every pass:

```ts
.find("workflow_step_emission", /* every emission for the instance */)
.find("workflow_step", /* every step for the instance */)
.find("workflow_event", /* every event for the instance */)
```

It then:

1. maps every retrieved emission into a new `LogicalStepEmissionRow`;
2. calculates canonical and noncanonical executions over the full set;
3. repeatedly filters the full emission array for each open step;
4. constructs a combined historical-plus-created emission array;
5. maps every canonical row into a new `observedItems` array;
6. asks `BufferedDatabasePump.#deliverObserved` to walk the complete array, even though its observer
   cursor will reject almost all historical rows.

The pump therefore uses the database as a full snapshot source while its observer API behaves as a
delta consumer. The mismatch forces historical state through query execution, decoding,
canonicalization, allocation, and cursor checks on every tick.

The current delta-based pump removes this full-history user-emission path. The isolated 100 versus
10,000 history benchmark and both current-code full workloads confirm that the original cumulative
allocation hotspot no longer appears at its previous scale.

## Original secondary cause — resolved: cumulative assistant-message processing

At the time of the September 2 run,
`packages/pi-harness/src/pi/harness/agent-harness-event-protocol.ts` retained the current projected
assistant message and processed the provider's cumulative partial message on every update.

For each `message_update`, it:

- checks whether the new cumulative string starts with the previous cumulative string;
- slices the appended suffix;
- snapshots the complete projected partial assistant message again.

The allocation profile attributed approximately 177 MB to the prefix/transition path alone. This
work remains linear per event in the current message length, so cumulative allocation grows faster
than the final output size.

The compact persisted event remains replayable, but the current encoder now updates the common text,
thinking, and tool-call append paths incrementally. The isolated protocol benchmark reports
near-linear normalized allocation growth for its encoder and decoder cases.

## Outbox stream amplification

`packages/fragno-db/src/fragments/internal-fragment.routes.ts` currently configures:

```text
poll interval:       300 ms
write timeout:       1 second
maximum stream life: 30 seconds
```

The CLI consumes NDJSON with stdout backpressure, remembers the last parsed versionstamp, and
reconnects one second after the server's finite lease ends. The CLI buffering did not appear to be a
worker heap problem.

A representative idle 30-second outbox request performed approximately:

- 95–100 polling passes;
- 225 Durable Object storage executions;
- 107 storage transactions;
- 645 total spans.

Multiple simultaneous streams were present during the workload. Logs showed overlapping stream
leases with separate poll counts and entry counts. Each connected client creates another
`BufferedDatabasePump`, so three clients can perform roughly three times the idle polling and trace
work for the same scope.

The trace store contained, at the time of investigation:

- 683,162 spans;
- 275,642 `durable_object_storage_exec` spans;
- 77,780 `fragno.db.handler.internal.outbox.stream.list` spans;
- approximately 533 MB of SQLite trace data.

With one listener running for 35 seconds, the trace database grew by 602 KB. With the listener
stopped for another 35 seconds, it did not grow. Workerd RSS fell by approximately 143 MB during the
stopped interval, although RSS includes SQLite page cache and other native allocations and should
not be equated directly with JS heap.

Outbox polling remains an unresolved amplifier, especially with multiple clients. With the original
full-history workflow emission pump resolved, shared polling ownership is now one of the remaining
sources of avoidable database and trace work.

## Debugger console retention

The post-workload snapshot contained 9,400 global handles labelled `DevTools console`, compared with
27 before the workload:

- 8,400 logged objects;
- 954 `backoffice.durable_object_sql.query_metrics` event strings;
- stream and durable-hook lifecycle log arguments.

Repeated generated SQL strings had this retainer path:

```text
(Global handles) / DevTools console
  -> structured query-metric Object
  -> properties
  -> Object.sql
  -> generated SQL string
```

At the time of this snapshot,
`apps/backoffice/app/backoffice-runtime/cloudflare-database-query-instrumentation.ts` logged one
structured object per aggregated SQL bucket whenever a five-second window or row threshold flushed.
The worktree removes that logger and disables the optional dialect query instrumentation in
Backoffice. Wrangler's inspector proxy enables the Runtime domain and calls
`Runtime.discardConsoleEntries` on worker reload, but not periodically during a long-lived debug
session.

Calling `Runtime.discardConsoleEntries`, followed by a forced GC, reduced used heap from
approximately 65.0 MB to 56.7 MB.

This retention is specific to debugger-enabled local development, but it materially obscures memory
investigations and increases peak pressure during query-heavy streams.

## Action plan

### P0: bound terminal step-emission cleanup SQL and working memory

The current worktree replaces the one-shot cleanup with 100-row durable pages and bounded truncate
notifications. Each page performs one retrieve/mutate UOW and atomically schedules its continuation.
The 207-row SQLite scenario and 6,000-emission Workerd run prove final-state cleanup. The first
September 25 cleanup-only comparison showed 270.31 MiB sampled allocation and a 35.58 MiB peak rise
for 10,000 rows, including 20,000 individual `DELETE` statements. Bounded bulk deletes reduced that
to 91.30 MiB sampled allocation, a 19.80 MiB peak rise, and 300 deletion statements by construction.
The reduction is material, but the peak still grows with total history. Test interruption/concurrent
retries and resumed client projection before declaring cleanup complete.

Required properties:

- Do not retrieve every step emission and every related outbox mutation into one JavaScript array.
- Bound each cleanup attempt by an explicit row or byte limit.
- Continue cleanup durably across attempts without interactive transactions or an in-memory source
  of truth.
- Preserve two-phase OCC, idempotency, and retry safety if a cleanup attempt fails after committing.
- Keep truncate notifications and their external-ID lists bounded per page; verify that every
  deleted ID is invalidated for resumed clients.
- Preserve client projection correctness when deleted emissions are present in IndexedDB or another
  resumed outbox consumer.
- Keep each hook attempt within Fragno's one-retrieval-round-trip and one-mutation-round-trip
  constraints.
- Avoid one SQL execution or transaction whose duration grows with complete emission history.

Keep the cleanup-only short/long workload as a regression. Bounded bulk mutations now pass the
functional regression and substantially reduce allocation, but they do not yet prove that peak heap
is governed by page size rather than total history. Isolate and reduce the remaining per-page
retrieval, durable-hook continuation, truncate/outbox, and transaction overhead. Keep query
instrumentation out of authoritative memory runs and collect statement counts separately.

### P0 (primary): reduce streaming allocation and natural-GC peak

Instrumentation now separates streaming, cleanup, and post-cleanup allocation sampling and provides
a separate heap-only mode:
[`../scripts/profile-streaming-heap.md`](../scripts/profile-streaming-heap.md). The
[single-command benchmark](../scripts/benchmark-streaming-heap.md) builds preview, provisions a
local benchmark account, repeats the heap-only turns, runs a separate allocation sample and the
fixed-workload benchmark, and records a JSON manifest. The workflow-step summary reports emissions
enqueued, successful and empty flush counts, and attempt duration; the outbox stream summary reports
polls, rows, and frame characters without re-encoding payloads. For SQL activity, use storage traces
rather than reinstating query measurement on the production path. Correlate summaries by step and
timestamp. The profiler's `cleanup` phase ends at callback return **before the transaction may
finish**; its labeled `post-cleanup` phase can still include cleanup work. The sampler switch can
also miss allocations at that boundary. Sampled runs must not be used for the authoritative peak.
Compare comparable-length turns with one listener, using the **heap-only** mode for absolute peak
and the **sampled** mode to rank allocation stacks by phase.

The GC checkpoints show that the peak is mostly collectible work, not retained application state.
The sampled profile identified **per-operation query compiler construction** and **outbox/result
serialization** as large allocation paths, but sampler switching captured some cleanup allocations
in its labeled streaming window. Compiler reuse, narrow `RETURNING`, and batched outbox INSERTs have
now been measured incrementally with fixed Workerd emissions; their combined effect on the
production-preview peak remains unproven. Do not infer peak savings from cumulative allocation
alone. Compare individually against a fixed emission/output workload and a production-preview
heap-only run **without explicit GC during the measured turn**. A console-log-suppressed A/B reduced
log volume and sometimes reduced peak, but had shorter outputs and large GC-timing variance, so it
does not prove a peak fix. GC checkpoints are diagnostic only, not the product fix.

### Completed: make workflow emission flushing delta-based

The live pump now avoids repeatedly decoding persisted user-emission history and returns only newly
created observed rows. The isolated benchmark measured 43.40 MiB sampled allocation with 100
historical emissions and 52.47 MiB with 10,000 historical emissions while processing the same 300
new emissions. Duration remained approximately 3.9 seconds.

Keep the existing history benchmark as a regression. It must continue to verify rows read, decoded
object count, allocation, and peak heap against a large preexisting history.

### Completed: update the Pi event encoder incrementally

The common text, thinking, and streamed tool-call paths now use compact incremental updates. The
isolated encoder and decoder benchmarks pass the 1.25 normalized-growth limit while preserving
replay, replacement transitions, metadata, and tool-call behavior.

Keep the protocol benchmark and projection scenarios as regressions.

### Completed: disable Backoffice SQL query-metric instrumentation

A single 6,620-emission cleanup produced 7,450 structured SQL query-metric console calls and about
7.1 MB of preview output. The corresponding storage transaction occupied 19.61 seconds; two
no-SQL-log runs with shorter histories took 0.81–7.43 seconds at their longest storage
execution/transaction. Logging is an avoidable amplification even though its share of the natural-GC
heap peak remains unproven.

A bounded intermediate logger still emitted 1,864 SQL summaries across two preview turns and
provided no established natural-GC peak reduction. The Backoffice collector has been deleted. The
Durable Object dialect retains its opt-in `queryInstrumentation` API, but Backoffice passes `null`;
its disabled path skips per-query timing, row-read access, and metrics-object construction. Storage
traces remain available for on-demand diagnosis. Do not claim a lower product peak without a
comparable heap-only A/B. Periodic forced GC is not a product fix.

### P2: share outbox observation work

A scope should not create one independent 300 ms database poller per HTTP client.

> **Implemented September 25, 2026:** Active stream responses on one database adapter now share one
> registry-owned outbox pump and one elected scheduler loop. Catch-up observers progress in
> compatible cursor-and-limit groups with at most four pages per tick; observers at the live tail
> share one 50-entry poll and cannot be pinned by a historical or `limit=1` client. With one active
> lagging client, live benchmarks for 1 and 10 current clients both measured 40 outbox SQL reads. A
> 128 KiB workload with 2 current clients and 2 divergent catch-up clients measured the expected 60
> reads, a 33.4 MiB peak heap rise, and no retained-heap increase after GC. See
> `packages-private/pi-workflows-heap-benchmark/reports/2026-09-25-shared-outbox-observation.md`.
> The idle-polling and lease refinements below remain open.

Prefer one elected or registry-owned outbox pump per fragment instance, with each HTTP response as
an observer. If process boundaries require polling, only one local observer should own the fallback
poller at a time.

At minimum:

- back off polling when repeated passes return no entries;
- do not create a full transaction/span tree for every empty heartbeat;
- verify that disconnecting the last observer stops polling immediately;
- preserve the finite 30-second response lease without resetting database ownership each time.

This overlaps with the async pump ownership work in
`apps/backoffice/open-issues/backoffice-tracing-more.md`.

### P4: make long Pi turn waits honest

The original implementation started one `wait-for-agent-end?timeoutMs=60000` request, so long valid
turns returned a 408 while the agent continued and completed. The September 22 and first September
23 worktree builds queried unqualified table `workflow_instance` instead of persisted table
`workflow_instance_workflows`, yielding an immediate 500 after the prompt command committed. In the
later September 23 heap-only build, the worktree's waiter implementation had changed; `pi.runTurn`
returned successfully after a 67-second turn.

The current command-step waiter queries Workflows through its namespaced service. Focused route
tests cover the namespace, a short completion, timeout, terminal instance, and command failure; a
model-backed 67-second turn also returned successfully. These do **not** prove an end-to-end
long-wait guarantee. Add scenario coverage for a turn longer than 60 seconds, interruption, and
failure while work continues. A valid long turn must remain observable until its real terminal
state.

## Verification requirements

Add a deterministic long-stream scenario that records both behavior and memory-relevant work.

The scenario should prove:

1. A long assistant response reaches the final projected message correctly.
2. Outbox clients receive every mutation once and resume from a versionstamp.
3. The workflow step pump does not reread the complete emission history on every tick.
4. `observedItems` contains only new emissions.
5. Peak used JS heap does not grow in proportion to preexisting emission history.
6. Doubling final response length does not cause approximately four times the query/decoding
   allocation.
7. Two outbox clients do not create two independent database polling loops in one process.
8. Closing the final listener stops outbox stream storage spans promptly.
9. Backoffice keeps SQL query instrumentation disabled and remaining lifecycle logs do not leave
   console handles proportional to SQL execution count.
10. Long `pi.runTurn` calls do not report failure while the underlying agent remains active and
    later succeeds.
11. Terminal step-emission cleanup peak heap is bounded by cleanup batch size rather than complete
    emission history.
12. Cleanup remains replay-safe when interrupted between batches and does not emit duplicate or
    incomplete client invalidation.
13. Heap-only preview runs and isolated cleanup-history cases distinguish GC scheduling, cleanup,
    outbox polling, and console retention; the heap-only run has ruled out allocation sampling as
    the main explanation for the approximately 110 MiB observed peak.

For local manual verification, capture:

- `Runtime.getHeapUsage` at idle, during the turn, immediately before terminal cleanup, during
  cleanup, after completion, and after GC;
- one uninstrumented heap-only run and a separate allocation profile with probe distortion called
  out;
- rows read and returned for workflow emission and cleanup queries;
- cleanup batch count, rows per batch, longest SQL execution, and truncate payload size;
- outbox poll count and connected observer count;
- trace-store growth over a fixed interval;
- DevTools console handle count before and after the workload.

## Investigation artifacts

The local investigation left these disposable files under `/tmp`:

```text
/tmp/outbox-live-allocation-profile.json
/tmp/outbox-stream-before.heapsnapshot
/tmp/outbox-stream-after-workload-gc.heapsnapshot
/tmp/outbox-live-memory.tsv
/tmp/backoffice-outbox-live.ndjson
/tmp/pi-session-after-long-turn.json
```

They are not repository fixtures and may be deleted after the issue is reproduced by an automated
scenario.

## Completion criteria

This issue is complete when:

- workflow emission flush cost remains bounded by current scopes and newly observed rows rather than
  full persisted history;
- long Pi output no longer causes repeated full-history result allocation;
- terminal step-emission cleanup uses bounded working memory and bounded SQL work as total emission
  history grows;
- client invalidation after batched cleanup remains complete, resumable, and replay-safe;
- multiple local outbox clients share one polling owner;
- debugger query logging cannot retain an unbounded number of SQL metric object graphs;
- long `pi.runTurn` waits observe the real terminal state instead of returning an early 408 or 500;
- preview-mode regressions demonstrate bounded uninstrumented peak used heap and near-linear
  cumulative allocation as output length and persisted history increase.
