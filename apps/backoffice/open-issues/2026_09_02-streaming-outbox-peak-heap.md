# Streaming Pi output causes excessive transient heap allocation

Status: open

Created: September 2, 2026

Last updated: September 2, 2026

## Goal

Reduce peak heap usage while a Pi agent streams a long response and clients consume the Automations
outbox.

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

## Primary cause: full-history workflow emission flushes

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

This is the first issue to fix for peak heap reduction.

## Secondary cause: cumulative assistant-message processing

`packages/pi-harness/src/pi/harness/agent-harness-event-protocol.ts` retains the current projected
assistant message and processes the provider's cumulative partial message on every update.

For each `message_update`, it currently:

- checks whether the new cumulative string starts with the previous cumulative string;
- slices the appended suffix;
- snapshots the complete projected partial assistant message again.

The allocation profile attributed approximately 177 MB to the prefix/transition path alone. This
work remains linear per event in the current message length, so cumulative allocation grows faster
than the final output size.

The compact persisted event is appropriately delta-shaped. The encoder should avoid rebuilding a
full independent snapshot merely to derive that delta when the provider event already supplies the
append delta and the active message can be updated incrementally.

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

Outbox polling is a meaningful amplifier, especially with multiple clients, but it is secondary to
the full-history workflow emission pump during an active long response.

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

### P0: make workflow emission flushing delta-based

Change the step live pump so one pass does not retrieve or return the complete emission history.

Required properties:

- Persist and query after a stable emission cursor.
- Return only emissions that are new to the pump observer.
- Do not map historical canonical rows into `observedItems`.
- Avoid filtering the complete emission set once per open step.
- Retrieve only the step/execution state required to classify new rows as canonical.
- Keep event-consumption uniqueness and two-phase OCC behavior explicit.
- Preserve replay safety across process restart; in-memory cursor state may optimize a live process
  but cannot become the source of truth.

The first useful regression should run the same number of new emissions against a short and a long
preexisting history. Rows read, decoded object count, and peak used heap for the flush should remain
approximately constant.

### P1: update the Pi event encoder incrementally

Change the active assistant-message projection without snapshotting the complete cumulative partial
message on every delta.

Investigate whether the provider event contract makes `event.delta` authoritative for append-only
text and thinking updates. If replacement transitions remain required, detect them without cloning
the complete projected message on the common append path.

The persisted protocol must remain replayable and must still handle replacement, tool-call, and
metadata transitions correctly.

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

`pi.runTurn` starts one `wait-for-agent-end?timeoutMs=60000` request. Long valid turns therefore
return a 408 while the agent continues and completes.

Allow the requested codemode timeout to govern repeated bounded waits, or expose a turn wait option.
This is not the heap cause, but it makes long-response memory regressions unnecessarily difficult to
run and interpret.

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

For local manual verification, capture:

- `Runtime.getHeapUsage` at idle, during the turn, after completion, and after GC;
- an allocation profile with probe distortion called out separately;
- rows read and returned for workflow emission queries;
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

- workflow emission flush cost is bounded by current scopes and newly observed rows rather than full
  persisted history;
- long Pi output no longer causes repeated full-history result allocation;
- multiple local outbox clients share one polling owner;
- debugger query logging cannot retain an unbounded number of SQL metric object graphs;
- a long-stream regression demonstrates bounded peak used heap and near-linear cumulative allocation
  as output length increases.
