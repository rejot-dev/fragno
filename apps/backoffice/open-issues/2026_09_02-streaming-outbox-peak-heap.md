# Streaming Pi output causes excessive transient heap allocation

Status: open

Created: September 2, 2026

Last updated: September 23, 2026

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

A local long-response run produced a 31,412-character assistant message, 691 Automations outbox
entries, and 6.6 MB of NDJSON. The worker allocated approximately 5.95 GB during the 120-second
allocation-sampling window, although most of that memory was short-lived.

The primary allocation source was not writing NDJSON to the HTTP response. It was the Workflows step
live pump rebuilding the complete workflow emission projection every 100 ms:

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
2. Local debugger console entries retain structured SQL query-metric objects and their generated SQL
   strings until Wrangler reloads the worker or `Runtime.discardConsoleEntries` is called.

## Current status

### Resolved

The current worktree resolves the two original quadratic-allocation paths:

- The workflow live pump no longer retrieves, decodes, canonicalizes, and delivers the complete
  persisted user-emission history on every 100 ms pass. The isolated benchmark increased history
  from 100 to 10,000 emissions and measured only 21% more sampled allocation with almost unchanged
  duration.
- The Pi event encoder updates common text, thinking, and tool-call deltas incrementally. All
  isolated encoder and decoder growth checks passed the configured linear-growth limit.
- Production-preview measurement is now reproducible. Vite development mode is excluded because its
  `ModuleRunner` retained approximately 282 MiB of transformed source and inline source maps.

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

`onWorkflowStepEmissionsCleanup` still retrieves the full matching emission/outbox-mutation set,
constructs all deletion operations and external IDs, and emits one truncate notification. Across
three preview runs, the truncate listed 5,884–7,568 IDs; a single cleanup deletion lasted
12.78–21.05 seconds, including a 21.045-second execution in the GC-checkpoint run. This is an
unbounded SQL and payload scaling problem **even though cleanup is not proven to dominate peak live
JS heap**.

### Follow-up measurements

The September 22 rerun found approximately 80% lower cumulative sampled allocation for a comparable
long response, and the isolated workflow-history and Pi event-protocol benchmarks showed near-linear
behavior. Storage span volume remained high, multi-client outbox ownership was unverified, and the
current `pi.runTurn` waiter failed before observing completion.

That full rerun accidentally used the Vite development server. Its approximately 334 MiB baseline
was not application state: a fresh heap snapshot attributed 281.84 MiB of 297.08 MiB self size to
Vite `ModuleRunner` transformed-source strings and inline source maps.

The September 23 production-preview rerun started at 46.17 MiB, peaked at 110.73 MiB during the
sampled 120-second workload, fell to 54.56 MiB after GC, and settled at 50.45 MiB after console
discard and another GC. It sampled 1.151 GB of cumulative allocation, approximately 80.7% below the
September 2 run and approximately 76.2% lower per output character. The lower settled heap confirms
that the primary retained and cumulative-allocation behavior improved, but the sampled absolute peak
was approximately 21.7% higher and the baseline-to-peak delta was approximately 74.5% larger than in
the original run. The issue therefore remains open for peak transient heap and storage-operation
volume. A separate heap-only preview run confirmed the approximately 110 MiB peak without allocation
sampling, but did **not** establish terminal cleanup as its direct cause. In that later run
`pi.runTurn` completed successfully after the worktree's waiter code changed.

Detailed reports:

- [`references/2026_09_22-streaming-outbox-peak-heap-rerun.md`](references/2026_09_22-streaming-outbox-peak-heap-rerun.md)
  records the isolated benchmarks and the provisional development-server run.
- [`references/2026_09_23-streaming-outbox-preview-heap-profile.md`](references/2026_09_23-streaming-outbox-preview-heap-profile.md)
  records the sampled production-preview heap comparison, allocation profile, trace split, and
  artifacts.
- [`references/2026_09_23-streaming-outbox-preview-heap-only.md`](references/2026_09_23-streaming-outbox-preview-heap-only.md)
  records the unsampled heap experiment, cleanup/peak timing, and corrected attribution.
- [`references/2026_09_23-streaming-outbox-peak-cause.md`](references/2026_09_23-streaming-outbox-peak-cause.md)
  records the idle-listener control, GC checkpoints, and evidence distinguishing collectible
  streaming allocations from a retained cleanup object graph.

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

Use one long-lived CDP client for the complete measurement so allocation sampling, heap polling, and
profile collection belong to the same inspector session.

Before the turn:

1. enable `Runtime` and `HeapProfiler`;
2. call `Runtime.discardConsoleEntries`;
3. call `HeapProfiler.collectGarbage` with a timeout longer than 30 seconds;
4. wait briefly, then record `Runtime.getHeapUsage`;
5. start allocation sampling with a 32 KiB interval and collected minor/major objects included;
6. poll `Runtime.getHeapUsage` every 100 ms.

Run the long prompt with a 120-second codemode timeout. Keep profiling for the complete fixed
120-second window even if `pi.runTurn` returns before the underlying workflow finishes or reports a
waiter error. Verify completion afterward with `pi.getSession`.

At the end:

1. record heap usage before stopping sampling;
2. stop and save the allocation profile;
3. force GC and record heap usage;
4. discard console entries, force GC again, and record settled heap usage;
5. stop the outbox listener;
6. record NDJSON line count, byte count, and final versionstamp.

Do not take heap snapshots inside the allocation-sampling window. Snapshot creation and allocation
sampling both materially distort Workerd RSS.

### 5. Capture trace evidence last

After the turn, identify the largest trace in the workload time window and record:

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

`apps/backoffice/app/backoffice-runtime/cloudflare-database-query-instrumentation.ts` logs one
structured object per aggregated SQL bucket whenever a five-second window or row threshold flushes.
Wrangler's inspector proxy enables the Runtime domain and calls `Runtime.discardConsoleEntries` on
worker reload, but not periodically during a long-lived debug session.

Calling `Runtime.discardConsoleEntries`, followed by a forced GC, reduced used heap from
approximately 65.0 MB to 56.7 MB.

This retention is specific to debugger-enabled local development, but it materially obscures memory
investigations and increases peak pressure during query-heavy streams.

## Action plan

### P0: bound terminal step-emission cleanup SQL and working memory

The full-set cleanup is unbounded in work and payload size; its share of transient allocation has
not been isolated. Benchmark cleanup against fixed short and long emission histories while polling
heap without allocation sampling. Replace the one-shot cleanup working set with a bounded,
replay-safe cleanup operation.

Required properties:

- Do not retrieve every step emission and every related outbox mutation into one JavaScript array.
- Bound each cleanup attempt by an explicit row or byte limit.
- Continue cleanup durably across attempts without interactive transactions or an in-memory source
  of truth.
- Preserve two-phase OCC, idempotency, and retry safety if a cleanup attempt fails after committing.
- Remove the requirement to materialize every external ID in one truncate payload. Introduce a
  match-based or otherwise bounded invalidation operation rather than making a large optional field.
- Preserve client projection correctness when deleted emissions are present in IndexedDB or another
  resumed outbox consumer.
- Keep each hook attempt within Fragno's one-retrieval-round-trip and one-mutation-round-trip
  constraints.
- Avoid one SQL execution or transaction whose duration grows with complete emission history.

Add a scenario that runs the same terminal cleanup against short and long emission histories and
proves that peak heap and maximum SQL execution time are bounded by cleanup batch size, not total
history. Keep the outbox listener and console-log state controlled across both cases.

### P0 (primary): reduce streaming allocation and natural-GC peak

Instrumentation now separates streaming, cleanup, and post-cleanup allocation sampling and provides
a separate heap-only mode:
[`../scripts/profile-streaming-heap.md`](../scripts/profile-streaming-heap.md). The workflow-step
summary reports emissions enqueued, successful and empty flush counts, and attempt duration; the
outbox stream summary reports polls, rows, and frame characters without re-encoding payloads; the
Durable Object SQL window summary includes zero-row queries and SQL execution time. Correlate
summaries by step and timestamp. The profiler's phase switch can miss allocations at its boundaries,
and sampled runs must not be used for the authoritative peak. Compare comparable-length turns with
one listener, using the **heap-only** mode for absolute peak and the **sampled** mode to rank
allocation stacks by phase.

The GC checkpoints show that the peak is mostly collectible work, not retained application state.
The previous full allocation profile identified SuperJSON, Fragno DB/query construction, SSE
parsing, and SQL instrumentation as remaining owners. Profile allocations in separate streaming,
cleanup, and post-cleanup windows to identify the phase-specific hot stacks. Reduce avoidable
serialization and repeated query construction; verify improvement with the same output scale and a
preview heap-only run **without explicit GC during the measured turn**. GC checkpoints are
diagnostic only, not the product fix.

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

### P2: share outbox observation work

A scope should not create one independent 300 ms database poller per HTTP client.

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

### P3: bound debugger logging retention

Do not leave thousands of structured query-metric objects retained by the DevTools console.

Candidate changes, in preferred order:

1. Aggregate query metrics more aggressively so one workload produces far fewer console calls.
2. Avoid logging a fresh structured object for every SQL bucket when local observability already
   records equivalent information.
3. Add an explicit local-debug maintenance path that discards console entries between profiling
   phases.
4. Consider logging a bounded serialized summary rather than an object graph if the structured
   console object is not required by developers.

Do not treat periodic forced GC as a fix.

### P4: make long Pi turn waits honest

The original implementation started one `wait-for-agent-end?timeoutMs=60000` request, so long valid
turns returned a 408 while the agent continued and completed. The September 22 and first September
23 worktree builds queried unqualified table `workflow_instance` instead of persisted table
`workflow_instance_workflows`, yielding an immediate 500 after the prompt command committed. In the
later September 23 heap-only build, the worktree's waiter implementation had changed; `pi.runTurn`
returned successfully after a 67-second turn.

Verify the new command-step waiter with scenario tests for a short turn, a turn longer than 60
seconds, timeout, interruption, and failure. A valid long turn must remain observable until its real
terminal state rather than reporting failure while work continues.

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
9. Query-metric logging does not leave console handles proportional to SQL execution count.
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
