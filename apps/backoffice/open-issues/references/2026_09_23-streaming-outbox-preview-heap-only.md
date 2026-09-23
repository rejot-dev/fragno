# Production-preview heap-only follow-up — September 23, 2026

This follow-up to the
[sampled production-preview profile](2026_09_23-streaming-outbox-preview-heap-profile.md) tests
whether allocation sampling caused its higher observed JS heap peak. It does not change the
September 2 historical measurement.

## Setup

- Rebuilt `@fragno-apps/backoffice-rr` and launched a fresh Vite preview process; measured Workerd
  target `rejot-backoffice`.
- Ran the same 150-stanza poem prompt with `openai/gpt-5.6-luna`, fresh session
  `n293oxqgo7an293oxqgo7an2`, and one outbox listener starting at versionstamp
  `0000000000000000104a0000`.
- Enabled CDP Runtime and HeapProfiler for baseline/settled GC, **but never started allocation
  sampling or took a heap snapshot**.
- Polled `Runtime.getHeapUsage` approximately every 100 ms for 140 seconds, including the comparable
  first 120 seconds. Discarded console entries and forced GC before starting; forced GC and then
  discarded console entries and forced GC again at the end.
- This run used the current dirty worktree at commit `928ec39fe898252c09e78af10e3114a29a998559`. The
  worktree changed since the earlier sampled run, including the Pi turn-wait route; this is a
  controlled instrumentation comparison, **not** a same-binary A/B test. The model response and
  number of emissions also differ between runs.

`pi.runTurn` returned successfully at 67.4 seconds with `waiting` command/workflow status and 24,269
characters of assistant text. The outbox listener captured 550 lines, 4,630,190 bytes, and a final
truncate containing 5,884 external IDs. The waiter result differs from the earlier run's immediate
500 because the worktree's waiter implementation changed.

## Heap results

| Measurement                             | Sampled preview | Heap-only preview |
| --------------------------------------- | --------------: | ----------------: |
| Baseline after console discard/GC       |       46.17 MiB |         48.75 MiB |
| Highest observed in first 120 seconds   |      110.73 MiB |    **110.38 MiB** |
| Baseline-to-peak delta                  |       64.56 MiB |         61.63 MiB |
| Heap at 140 seconds, before explicit GC |    Not measured |         61.31 MiB |
| After explicit GC                       |       54.56 MiB |         54.14 MiB |
| After console discard and another GC    |       50.45 MiB |         50.69 MiB |

The unsampled peak differs by only **0.35 MiB** (approximately 0.3%) from the sampled peak despite a
different turn. Allocation-profiler metadata alone therefore cannot explain the observed
approximately 110 MiB peak. It does not establish that all 110 MiB was necessary _live application
state_: `usedSize` includes objects awaiting GC.

Heap-only samples:

|      Seconds after turn start |  Used heap |
| ----------------------------: | ---------: |
|                             0 |  48.75 MiB |
|                            35 |  77.08 MiB |
|                            60 |  94.66 MiB |
|      66 (workflow trace ends) |  97.83 MiB |
|           70 (cleanup active) |  93.03 MiB |
|       84 (cleanup trace ends) |  96.61 MiB |
|                            90 | 100.72 MiB |
|                           110 | 105.75 MiB |
|                    118 (peak) | 110.38 MiB |
|        119 (spontaneous fall) |  86.20 MiB |
| 135 (second spontaneous fall) |  61.49 MiB |
|                           140 |  61.24 MiB |

The timing matters: the late peak occurred about **34 seconds after cleanup ended**, while the
outbox listener remained connected. Used heap then fell by roughly 24 MiB without explicit GC near
119 seconds and another roughly 25 MiB near 134 seconds. This is consistent with delayed garbage
collection of transient work; this experiment **does not prove** that terminal cleanup is the direct
cause of the measured peak. It also does not isolate the contributions of streamed output, terminal
cleanup, outbox polling, or retained console entries. Discarding console entries after the final
explicit GC recovered approximately 3.62 MB.

## Trace correlation

Local Explorer query to select the two largest contiguous alarm traces for the measurement window:

```sql
SELECT trace_id, COUNT(*) AS span_count,
       MIN(start_ms) AS first_ms,
       MAX(start_ms + COALESCE(duration_ms, 0)) AS last_ms
FROM spans
WHERE start_ms BETWEEN 1790152840000 AND 1790153040000
GROUP BY trace_id
ORDER BY span_count DESC
LIMIT 20;
```

- Principal workflow trace `9a9e06e459a4965a74621adf9c4671f1`: `1790152866540`–`1790152932145`
  (65.605 s), 16,707 spans, including 15,428 storage executions and 1,189 transactions.
- Completion/cleanup trace `ba52563a6ffb063d87a4b1c0706171c7`: `1790152932148`–`1790152950008`
  (17.860 s), 3,650 spans, including 3,574 storage executions and 15 transactions. One
  outbox-mutation deletion took 17.594 seconds.
- From 90 to 140 seconds after measurement start, outbox list operations continued around 31–33 per
  ten-second interval, while storage execution counts fell to 66–88 per ten-second interval. Neither
  workflow nor cleanup was active at the 118-second peak.

The cleanup's full-set retrieval, 5,884-ID truncate payload, and 17.6-second deletion remain
important independent scaling issues. **Their share of transient peak heap is unproven**, so
prioritize an isolated cleanup-history/heap benchmark over assuming the whole peak belongs to
cleanup.

## Conclusion

The higher peak is **not primarily an artifact of allocation sampling**: the heap-only run reached
110.38 MiB, compared with 110.73 MiB while sampled. But the late peak happened well _after_ cleanup,
followed by two spontaneous large drops; delayed GC and ongoing polling/debugger activity need to be
separated before attributing the peak to cleanup. The initial September 2 run's approximately 95.4
MB peak was also local/debugger-instrumented; output and worktree differences limit direct causal
comparison.

## Artifacts

```text
/tmp/profile-backoffice-preview-heap-only-2026-09-23.mjs
/tmp/backoffice-heap-only-preview-2026-09-23-summary.json
/tmp/backoffice-heap-only-preview-2026-09-23-memory.tsv
/tmp/backoffice-heap-only-preview-2026-09-23-console.log
/tmp/backoffice-heap-only-preview-2026-09-23-run-turn.stdout
/tmp/backoffice-heap-only-preview-2026-09-23-run-turn.stderr
/tmp/backoffice-outbox-heap-only-preview-2026-09-23.ndjson
```
