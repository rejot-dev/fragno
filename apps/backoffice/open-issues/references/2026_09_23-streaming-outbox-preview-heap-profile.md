# Streaming outbox production-preview heap profile — September 23, 2026

This report completes the production-preview measurement requested by
[`2026_09_02-streaming-outbox-peak-heap.md`](../2026_09_02-streaming-outbox-peak-heap.md). It
replaces the absolute heap interpretation from the September 22 Vite-development-server rerun.

## Measurement context

The run used the dirty `bridge` worktree at Git commit `928ec39fe898252c09e78af10e3114a29a998559`.

Backoffice was built and served from the production Worker bundles:

```bash
pnpm exec turbo run build \
  --filter=@fragno-apps/backoffice-rr \
  --output-logs=errors-only

pnpm --filter @fragno-apps/backoffice-rr preview
```

Vite preview served Backoffice at `http://localhost:5173` and exposed the `rejot-backoffice` Workerd
inspector target on port `9229`.

The measurement used:

- a fresh preview process;
- one authenticated Automations outbox listener;
- a fresh Pi session, `y1xumaftwjf61xumaftwjf61`;
- model `openai/gpt-5.6-luna`;
- the same long-poem prompt as the September 2 and September 22 runs;
- a 120-second allocation profile with a 32 KiB sampling interval;
- objects collected by minor and major GC included;
- `Runtime.getHeapUsage` polling approximately every 100 ms;
- console discard and successful forced GC before the baseline, after the profile, and after the
  final console discard.

The outbox listener resumed after versionstamp `00000000000000000d340000`.

## Workload result

The completed session contained two messages and 25,543 characters of assistant text. The listener
received:

- 790 NDJSON records;
- 4,946,779 bytes;
- mutations through versionstamp `0000000000000000104a0000`.

`pi.runTurn` again returned an immediate 500 because the completion waiter queried unqualified table
`workflow_instance`. The command had already committed, so the workflow continued and completed.
`pi.getSession` later reported the workflow in `waiting` state with the completed assistant message.

## September 2 comparison

| Metric                            |           September 2 |  September 23 preview |               Change |
| --------------------------------- | --------------------: | --------------------: | -------------------: |
| Assistant text                    |          31,412 chars |          25,543 chars |               -18.7% |
| Outbox records                    |                   691 |                   790 |               +14.3% |
| NDJSON bytes                      |             6,615,808 |             4,946,779 |               -25.2% |
| Sampled allocation                | approximately 5.95 GB |   1,150,732,592 bytes | approximately -80.7% |
| Allocation per output character   |  approximately 189 KB |   approximately 45 KB | approximately -76.2% |
| Allocation per outbox record      | approximately 8.61 MB | approximately 1.46 MB | approximately -83.1% |
| NDJSON bytes per output character |     approximately 211 |     approximately 194 |  approximately -8.0% |

The response was shorter than the original, but the normalized allocation reductions remain large.
The production-preview result corroborates the September 22 development-server allocation result:
preview allocated 4.7% fewer total bytes than September 22, while producing 13.7% less assistant
text. Allocation per output character was 10.4% higher than September 22, so the two current-code
runs are in the same general range rather than proving an additional preview-mode improvement.

## Heap result

| Point                                 |           September 2 |           September 23 preview |
| ------------------------------------- | --------------------: | -----------------------------: |
| Baseline after console discard and GC | approximately 56.6 MB |   48,408,996 bytes / 46.17 MiB |
| Highest observed during profile       | approximately 95.4 MB | 116,108,700 bytes / 110.73 MiB |
| End of 120-second profile             | approximately 95.4 MB | 116,108,700 bytes / 110.73 MiB |
| After forced GC                       | approximately 62.0 MB |   57,212,268 bytes / 54.56 MiB |
| After console discard and GC          | approximately 56.7 MB |   52,903,592 bytes / 50.45 MiB |

The current baseline is approximately 14.5% lower than the September 2 baseline, proving that the
previous 334 MiB value was Vite development-runtime overhead.

The sampled peak is nevertheless approximately 21.7% higher in absolute bytes. The current
baseline-to-peak increase was 67.70 MB, compared with approximately 38.8 MB originally, a 74.5%
larger transient delta. The highest value occurred at the end of the fixed profiling window rather
than at one isolated spike.

Forced GC reduced current used heap by 58.90 MB. Discarding console entries and collecting again
recovered another 4.31 MB. The final absolute heap was approximately 6.7% below the September 2
final value, although it remained 4.49 MB above the lower current baseline.

Allocation sampling retains profiler metadata and changes Workerd memory behavior, so this result is
a comparison of equivalently instrumented local runs, not an uninstrumented production peak.

### Current memory curve

Representative samples from the 120-second profile:

|                      Elapsed |  Used heap |
| ---------------------------: | ---------: |
|                          0 s |  46.17 MiB |
|                         30 s |  70.38 MiB |
|                         60 s |  70.50 MiB |
|                         90 s | 100.28 MiB |
|                        120 s | 110.73 MiB |
|                     After GC |  54.56 MiB |
| After console discard and GC |  50.45 MiB |

A later [heap-only follow-up](2026_09_23-streaming-outbox-preview-heap-only.md) reached 110.38 MiB
without allocation sampling. Its peak occurred about 34 seconds **after** cleanup ended; this
profile alone cannot assign the late rise to cleanup or profiler metadata.

## Allocation result

The profile sampled 1,150,732,592 bytes, or 1.0717 GiB, during the fixed 120-second window.

Largest leaf allocation frames included:

| Leaf frame                               | Sampled allocation |
| ---------------------------------------- | -----------------: |
| SuperJSON traversal near `index.js:8281` |          91.15 MiB |
| Native `bind`                            |          67.31 MiB |
| SuperJSON `walker`                       |          62.87 MiB |
| Durable Object SQLite `executeQuery`     |          40.53 MiB |
| Native `values`                          |          38.55 MiB |
| Native `entries`                         |          34.31 MiB |
| Kysely `visitIdentifier`                 |          32.45 MiB |
| Native iterator `next`                   |          29.82 MiB |
| Fragno `NamingResolver`                  |          26.92 MiB |
| OpenAI `iterSSEChunks`                   |          23.89 MiB |
| Query instrumentation `formatLog`        |          13.36 MiB |
| Outbox `writeRaw`                        |           6.74 MiB |

The original full-history workflow reconstruction and cumulative Pi prefix-comparison sites do not
reappear at their previous scale. SuperJSON traversal, database/query construction, SSE parsing, and
query instrumentation are the clearest remaining allocation owners.

## Trace result

The workflow was split across two causally contiguous traces because durable-hook propagation
context remains absent.

The principal workflow trace was:

```text
3eb6d39ce77595f6a35db1b2e5ae8ba4
```

It covered 86.807 seconds and contained:

- 19,029 spans;
- 17,310 `durable_object_storage_exec` spans;
- 1,629 `durable_object_storage_transaction` spans;
- two `fragno.durable_hook.attempt` spans;
- `fragno.hook.has_propagation_context = false` on both attributed attempts.

The immediate completion and cleanup trace was:

```text
18f72bd05307842ab7d5ca1a14948514
```

It followed without a gap, covered 13.060 seconds, and contained:

- 3,650 spans;
- 3,574 `durable_object_storage_exec` spans;
- 15 `durable_object_storage_transaction` spans;
- the Pi `onOperationCompleted` durable-hook attempt without propagation context.

Combined, the causally contiguous operation covered 99.874 seconds and contained 22,679 spans,
20,884 storage executions, and 1,644 storage transactions. The combined counts are 8.8%, 7.8%, and
18.1% above the single September 2 trace respectively. The previous reports selected one
representative trace, so this combined comparison is deliberately conservative and includes the
separate current cleanup trace.

Dominant SQL operations across both traces included:

- 6,184 workflow step-emission inserts;
- 6,189 outbox-mutation inserts;
- 824–825 executions of each workflow instance, step, event, and system-emission retrieval query;
- 784 outbox entry inserts;
- 1,768 workflow step-emission deletes during cleanup;
- 1,768 matching outbox-mutation deletes during cleanup.

One cleanup delete execution took approximately 12.78 seconds. Storage-operation volume therefore
remains unresolved even though cumulative allocation is much lower.

## Assessment

The production-preview rerun confirms that the primary September 2 allocation pathology is
materially improved:

- cumulative sampled allocation is approximately 80.7% lower;
- allocation per output character is approximately 76.2% lower;
- allocation per outbox record is approximately 83.1% lower;
- the final post-GC and post-console-discard absolute heap values are below September 2.

It does not show an improved sampled peak. The measured peak reached 110.73 MiB, above the original
approximately 95.4 MB, and the baseline-to-peak delta was materially larger. Most of that transient
heap was collectible, but the issue's peak-heap completion criterion is not yet satisfied.

A subsequent
[preview workload without allocation sampling](2026_09_23-streaming-outbox-preview-heap-only.md)
confirmed a similar observed peak. Its maximum occurred well after cleanup ended and fell in two
large spontaneous steps, so the timing does **not** prove cleanup caused the maximum. Independently,
the trace still justifies reducing per-emission persistence, repeated 100 ms state queries, and
cleanup cost.

## Artifacts

```text
/tmp/backoffice-preview-memory-profile-summary-120s-2026-09-23.json
/tmp/backoffice-outbox-preview-memory-120s-2026-09-23.tsv
/tmp/outbox-preview-allocation-profile-120s-2026-09-23.json
/tmp/backoffice-outbox-preview-2026-09-23.ndjson
/tmp/backoffice-outbox-preview-2026-09-23.stderr
/tmp/pi-create-session-preview-2026-09-23.json
/tmp/pi-run-turn-preview-120s-2026-09-23.json
/tmp/pi-run-turn-preview-120s-2026-09-23.stderr
/tmp/pi-session-after-preview-long-turn-2026-09-23.json
/tmp/pi-session-after-preview-long-turn-2026-09-23.stderr
/tmp/backoffice-preview-profiler-console-2026-09-23.log
```
