# Streaming outbox peak heap rerun — September 22, 2026

This report records a follow-up measurement for
[`2026_09_02-streaming-outbox-peak-heap.md`](../2026_09_02-streaming-outbox-peak-heap.md). It
describes the current worktree result; it does not supersede the original investigation.

## September 23 correction

The full Backoffice measurement in this report accidentally used the Vite development server. A
fresh heap snapshot subsequently showed that 281.84 MiB of 297.08 MiB self size was retained string
data from Vite `ModuleRunner` transformed modules, V8 script source, and inline base64 source maps.
This was development-tooling state, not Backoffice domain state.

Running the same built application with `pnpm --filter @fragno-apps/backoffice-rr preview` retained
the Workerd inspector and produced a 48.4 MiB baseline, close to the original investigation's 56.6
MB baseline. The 333.96 MiB baseline and 410.15 MiB absolute peak below are not valid product heap
comparisons. The sampled allocation and workload delta remained useful evidence and were
subsequently corroborated by the September 23 production-preview run.

See
[`2026_09_23-streaming-outbox-preview-heap-profile.md`](2026_09_23-streaming-outbox-preview-heap-profile.md)
for the authoritative absolute heap comparison. Use the fast reproduction procedure in the parent
issue for future measurements.

## Measurement context

The rerun used the dirty `bridge` worktree at Git commit `928ec39fe898252c09e78af10e3114a29a998559`.
The worktree contained the pending workflow pump, Pi event protocol, and long-turn waiter changes
under investigation.

Runtime versions:

- Node.js `v24.18.0`;
- pnpm `11.1.3`;
- Wrangler `4.118.0` for the isolated workflow benchmark.

The full Backoffice workload ran against `http://localhost:5173` through the Vite development
server. The Workerd inspector target was `rejot-backoffice` on port `9229`. Future runs must use a
production build through Vite preview.

Allocation sampling changes Workerd memory behavior by retaining profiler metadata. Sampled
allocation is suitable for comparing cumulative allocation ownership. Process RSS and the
allocation-profiled peak are not uninstrumented production peak measurements.

## Workloads

### Full Backoffice Pi turn

A fresh Pi session used `openai/gpt-5.6-luna`. One authenticated Automations outbox listener resumed
from the latest versionstamp before the turn. The prompt matched the original investigation:

```text
Write a very long poem. Make it at least 150 substantial stanzas, rich in imagery and narrative,
and continue until you have used as much of your available response as possible.
```

The inspector recorded `Runtime.getHeapUsage` every 100 ms and retained a 120-second allocation
sample with objects collected by minor and major GC included. The measurement discarded console
entries and forced GC before the baseline. At the end it measured heap before GC, after GC, and
after console discard plus another GC.

`pi.runTurn` returned an immediate HTTP 500 from its completion waiter. The command had already been
accepted, so the underlying workflow continued. The outbox stream observed the response, and a later
`pi.getSession` verified a two-message session with a 29,611-character assistant message.

### Workflow history benchmark

The isolated Workerd benchmark ran the same 300 new emissions over 30 live-pump intervals against
100 and 10,000 preexisting emissions. Each case ran in three fresh Wrangler processes for heap and
allocation modes.

```bash
pnpm --filter @fragno-private/workflows-heap-benchmark measure -- \
  --mode both \
  --histories 100,10000 \
  --runs 3 \
  --batch-count 30 \
  --emissions-per-batch 10 \
  --payload-bytes 256 \
  --interval-ms 125 \
  --json /tmp/workflows-heap-benchmark-2026-09-22.json
```

### Pi event protocol benchmark

The Pi Harness allocation benchmark exercised text and streamed tool-call payloads in fresh Node.js
processes.

```bash
pnpm --filter @fragno-dev/pi-harness measure:event-encoder -- \
  --json /tmp/pi-event-encoder-2026-09-22.json
```

## Full workload result

The profiled workload produced:

- 29,611 assistant text characters;
- 807 Automations outbox records;
- 5,530,976 bytes of NDJSON;
- outbox versionstamps through `00000000000000000d340000`;
- 1,207,929,464 sampled allocation bytes during the 120-second profile.

### Heap

| Point                             |  Used heap |
| --------------------------------- | ---------: |
| Baseline after console discard/GC | 333.96 MiB |
| Highest observed during profile   | 410.15 MiB |
| End of 120-second profile         | 410.15 MiB |
| After forced GC                   | 338.99 MiB |
| After console discard and GC      | 334.54 MiB |

The observed peak delta was 76.19 MiB. The settled delta after console discard and GC was 0.57 MiB.
Debugger console retention accounted for approximately 4.45 MiB after the workload.

A separate fresh Backoffice restart measured approximately 333.5 MiB used heap before another long
turn. This corroborates the high baseline, although the attempted explicit GC on that fresh process
timed out. The successful pre-profile GC and the settled post-profile value both remained near 334
MiB.

The original September 2 run reported approximately 56.6 MB idle and 95.4 MB before forced GC. The
higher values in this table came from Vite development-runtime source retention and must not be used
as evidence of a product baseline regression. A subsequent production-build preview measured a 48.4
MiB baseline.

### Allocation

The profile sampled 1.208 GB of cumulative allocation, compared with approximately 5.95 GB in the
original investigation. This is an approximate 80% reduction for a similarly sized response.

Allocation grouped by the leaf call-frame source was:

| Group                     | Sampled allocation |
| ------------------------- | -----------------: |
| Other runtime/application |         588.08 MiB |
| `@fragno-dev/db`          |         263.27 MiB |
| SuperJSON                 |         233.96 MiB |
| OpenAI SSE parsing        |          37.54 MiB |
| Query instrumentation     |          15.05 MiB |
| Outbox `writeRaw`         |           7.80 MiB |
| `@fragno-dev/workflows`   |           3.78 MiB |
| `@fragno-dev/pi-harness`  |           2.48 MiB |

Leaf-frame grouping does not assign generic library allocations back to the caller that caused them.
It is useful for identifying current hot sites, not for treating each package value as total
ownership.

The largest individual sites were SuperJSON traversal and copy operations, SQL execution and query
construction, OpenAI SSE parsing, query instrumentation formatting, serialization, and response
stream writes. The original dominant full-history workflow and Pi protocol sites no longer appeared
at comparable scale.

## Workflow history benchmark result

Median results across three fresh processes per case:

| Mode       | Historical emissions | Peak delta | Settled delta | Sampled allocation | Duration |
| ---------- | -------------------: | ---------: | ------------: | -----------------: | -------: |
| Heap       |                  100 |   2.84 MiB |      2.27 MiB |                  — | 4,102 ms |
| Heap       |               10,000 |   5.77 MiB |    -10.92 MiB |                  — | 4,168 ms |
| Allocation |                  100 |          — |             — |          43.40 MiB | 3,883 ms |
| Allocation |               10,000 |          — |             — |          52.47 MiB | 3,943 ms |

Increasing preexisting history by 100 times increased sampled allocation by approximately 21%, not
100 times. Peak delta approximately doubled. The negative settled delta for the 10,000-row case
means GC collected allocations that were live at the post-seeding baseline; it is not a negative
cost.

The benchmark seeds historical user emissions. The current live pump retrieves persisted system
control emissions while delivering newly created user emissions directly. The benchmark therefore
proves that the large persisted user-emission history is no longer repeatedly decoded by each live
flush. It does not model an unusually large history of system control emissions.

## Pi event protocol result

All benchmark growth checks passed the configured 1.25 normalized-growth limit.

- Text encoder normalized allocation growth ranged from `0.93x` to `1.08x`.
- Text decoder normalized allocation growth ranged from `0.88x` to `1.03x`.
- Tool-call encoder normalized allocation growth ranged from `0.92x` to `0.94x`.
- Tool-call decoder normalized allocation growth ranged from `0.92x` to `0.97x`.
- Encoded wire growth remained approximately linear at `1.00x` normalized growth.

These results support near-linear cumulative allocation for the isolated compact protocol paths.

## Trace result

The representative full-workload trace was:

```text
c0227c357cebe7173f42375be6510bb4
```

It covered 89.175 seconds and contained 20,681 spans:

- 18,918 `durable_object_storage_exec` spans;
- 1,661 `durable_object_storage_transaction` spans;
- two `fragno.durable_hook.attempt` spans;
- no propagation-context value on either durable-hook attempt.

The original trace had 20,854 spans, 19,378 storage executions, and 1,392 storage transactions.
Cumulative allocation fell substantially, but total trace and storage-operation counts remained at
approximately the same scale. Transactions increased by approximately 19%.

The dominant repeated operations in the new trace included 6,941 workflow emission insert spans,
6,946 outbox-mutation insert spans, approximately 840 passes over workflow instance, step, event,
and system-emission state, and 801 outbox entry inserts.

The current system-emission retrieval query returned 2,515 rows across 839 executions, approximately
three rows per pass. This is materially different from decoding a growing user-emission history on
every pass, but the 100 ms pump and per-emission persistence still produce a large trace tree.

One outbox listener was used. This rerun does not prove that two clients share a polling owner. The
recent trace window contained 638 `fragno.db.handler.internal.outbox.stream.list` spans, so outbox
polling remains a measurable amplifier.

## Long-turn waiter failure

The current `pi.runTurn` call returned a 500 before the model turn completed. The waiter attempted a
query against unqualified table `workflow_instance` and Workerd rejected it. The persisted table in
this integration is namespaced as `workflow_instance_workflows`.

The failure differs from the original fixed 60-second 408, but it still violates the requirement
that a valid long turn remain observable until completion. The workload itself continued and
completed because the prompt command had already been committed.

## Assessment against the action plan

### P0: workflow emission flushing

The full workload allocation and isolated history benchmark show a substantial improvement. Large
persisted user-emission history is no longer repeatedly decoded and delivered to observers.

The remaining 100 ms full-state control queries and per-emission SQL/outbox work still create nearly
19,000 storage execution spans for one long response.

### P1: Pi event encoder

The isolated text and tool-call benchmarks pass the linear-growth guard. Direct Pi Harness leaf
allocation was small in the full workload profile.

### P2: shared outbox observation

Not verified. The rerun used one listener, and polling span volume remains high.

### P3: debugger logging retention

Console discard recovered approximately 4.45 MiB after forced GC. Retention is lower than the
approximately 8 MB recorded originally, but query instrumentation still allocated approximately 15
MiB and retained console state proportional to emitted logs.

### P4: honest long-turn waits

Not complete. The current waiter fails with a table-qualification error before it can exercise the
intended bounded waiting behavior.

## Conclusion

The primary quadratic allocation problem is materially improved: the full workload sampled about 80%
less cumulative allocation, the workflow history benchmark remains close to constant across a
100-times history increase, and the Pi event protocol benchmarks are linear.

The issue is not complete. The later production-preview run confirmed lower cumulative allocation
and settled heap but measured a higher sampled transient peak. Storage span volume remains high,
multi-client outbox ownership was not verified, debugger logging still retains memory, and
`pi.runTurn` currently reports a 500 while the underlying turn continues.

## Artifacts

The rerun left disposable files under `/tmp`:

```text
/tmp/backoffice-memory-profile-summary-120s-2026-09-22.json
/tmp/outbox-live-allocation-profile-120s-2026-09-22.json
/tmp/backoffice-outbox-live-memory-120s-2026-09-22.tsv
/tmp/backoffice-outbox-live-120s-2026-09-22.ndjson
/tmp/pi-session-after-long-turn-120s-2026-09-22.json
/tmp/workflows-heap-benchmark-2026-09-22.json
/tmp/pi-event-encoder-2026-09-22.json
```
