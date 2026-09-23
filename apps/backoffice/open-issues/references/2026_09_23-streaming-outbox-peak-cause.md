# Streaming outbox peak heap: controlled GC checkpoints — September 23, 2026

This investigation follows the
[sampled preview profile](2026_09_23-streaming-outbox-preview-heap-profile.md) and
[heap-only preview profile](2026_09_23-streaming-outbox-preview-heap-only.md). It tests whether the
higher observed peak represents necessary live cleanup state, a buildup of collectible allocations,
or idle outbox polling.

## Setup

Both experiments used the built Worker under Vite preview, the `rejot-backoffice` Workerd inspector,
`Runtime.getHeapUsage` polling approximately every 100 ms, and **no allocation sampling or heap
snapshots**. GC and console discard were invoked explicitly at checkpoints; the checkpoint run is
diagnostic, not an uninstrumented production peak. The local worktree was dirty; these runs should
not be interpreted as exact same-binary A/B comparisons against earlier runs.

### Idle-listener control

With one outbox listener attached, no agent turn, and console entries discarded before the baseline:

| Point                              |                    Used heap |
| ---------------------------------- | ---------------------------: |
| After GC, at start                 | 48,806,976 bytes / 46.55 MiB |
| Highest in 50-second idle interval | 53,968,104 bytes / 51.47 MiB |
| At 50 seconds, before GC           | 52,720,928 bytes / 50.28 MiB |
| After GC                           | 49,588,296 bytes / 47.29 MiB |

Idle outbox polling alone added at most 5.16 MB before GC, far short of the extra approximately
50–60 MB in the long-turn profiles.

### Long-turn GC checkpoints

A fresh session `z1qw23i9acsp1qw23i9acsp1` used `openai/gpt-5.6-luna` and the same long-poem prompt
as the earlier runs. `pi.runTurn` returned successfully with 31,075 assistant characters and a
`waiting` command status. One listener received 749 NDJSON records (5,957,329 bytes); the final
truncate notification contained 7,568 emission IDs. Unlike the earlier 25,543- and 24,269-character
turns, this response is close in length to the original September 2 response of 31,412 characters.
Model output, emission count, and current worktree still vary between runs.

| Point                                                                          |                    Used heap |    Change after action |
| ------------------------------------------------------------------------------ | ---------------------------: | ---------------------: |
| Baseline after console discard and GC                                          | 51,224,228 bytes / 48.85 MiB |                      — |
| Streaming at 45 seconds, before GC                                             | 63,816,044 bytes / 60.86 MiB |                      — |
| Streaming at 45 seconds, after GC                                              | 55,812,976 bytes / 53.23 MiB |  **8.00 MB recovered** |
| Turn returned at 88.6 seconds, during cleanup, before GC                       | 99,692,884 bytes / 95.07 MiB |                      — |
| Immediately after GC at 88.9 seconds                                           | 58,100,592 bytes / 55.41 MiB | **41.59 MB recovered** |
| After truncate notification (cleanup still active), another GC at 89.2 seconds | 58,077,532 bytes / 55.39 MiB |      0.02 MB recovered |
| With listener still attached, 35 seconds later, before GC                      | 60,164,912 bytes / 57.38 MiB |                      — |
| After GC                                                                       | 57,928,496 bytes / 55.25 MiB |      2.24 MB recovered |
| After console discard and GC                                                   | 53,045,220 bytes / 50.59 MiB |  **4.88 MB recovered** |
| After listener stop, at 139 seconds                                            | 53,406,668 bytes / 50.93 MiB |                      — |

The final two attempted GC commands after listener shutdown timed out; the earlier checkpoint
collections completed successfully and the heap was already near its settled value before shutdown.

The maximum observed in this checkpoint run was **99.69 MB** (95.07 MiB). It was reached while the
large cleanup deletion was active, but a GC completed in approximately 300 ms _during that deletion_
and immediately reclaimed **41.59 MB**, returning usage to 58.10 MB. This directly rules out the
hypothesis that those 41.59 MB were a necessary, continuously reachable JavaScript cleanup working
set at that instant. The full-set cleanup may still allocate temporary objects; we have not
separated its allocations from the earlier streaming phase's garbage.

Without intervening GC, the previous heap-only run reached **115.74 MB** (110.38 MiB), versus 99.69
MB with a streaming-phase GC, despite the checkpoint run producing 28% more assistant text. Output
differences and GC interventions prevent treating the 16.05 MB difference as a controlled estimate
of any one allocator. They do demonstrate that when V8 collects temporary work has a large effect on
the observed peak. Do not add periodic forced GC as a product fix: reduce allocations and bound
expensive operations instead.

## Trace timing and cleanup

The long-turn trace was `dc879ec6fb1e53ae684c544e76b77e99`, from `1790153985235` to `1790154071982`
(86.747 seconds), with 21,647 spans, including 19,974 storage executions and 1,583 storage
transactions. The next alarm/cleanup trace was `5c9a6d83fccb4f279a024e71dafc87d0`, from
`1790154071986` to `1790154093359` (21.373 seconds), with 3,650 spans, including 3,574 storage
executions. A single `fragno_db_outbox_mutations` delete began at `1790154072314` and lasted
**21.045 seconds**. The GC request at `1790154073273` and post-GC heap measurement at
`1790154073571` both occurred while this SQL execution was in flight.

The truncate notification was visible to the outbox listener before the cleanup trace finished.
Seeing `truncate` in the listener is therefore **not** a reliable signal that the cleanup hook has
fully ended. Use the trace's end timestamp instead.

The previous heap-only run had no explicit GC during the turn; its workflow/cleanup traces ended
around 84 seconds but its peak occurred around 118 seconds, followed by two spontaneous drops of
roughly 24 and 25 MiB. Combining both runs shows that the late peak was **not** evidence that
cleanup continued running until 118 seconds; it reflects delayed collection of short-lived
allocations.

## Root cause and limits

**Proximate cause of the large used-JS-heap peak:** rapid production of short-lived objects during
the streamed workflow, persistence/query decoding, event and outbox serialization, and cleanup,
combined with GC timing. Without a collection at the right time, those objects remain counted in
`Runtime.getHeapUsage.usedSize` after the originating work is complete. The experimental forced GC
removed 41.59 MB while cleanup was running, and the earlier unsampled run spontaneously dropped by
roughly 49 MB later. Console-retained log arguments added another 4.88 MB in the checkpoint run;
idle polling alone did not reproduce the large rise.

The earlier full allocation profile found substantial allocation in SuperJSON traversal/copy, Fragno
DB and SQL/query construction, OpenAI SSE parsing, and instrumentation. It measured _total
allocations_, not how many bytes each path contributed to the particular instantaneous peak. An
additional phase-window allocation profile or isolated short/long cleanup benchmark would be needed
to partition the **collectible garbage** between streaming, cleanup, and other activity. The
evidence does not justify assigning all peak memory to cleanup.

**Separate confirmed issue:** terminal cleanup still scans/materializes a complete emission history
and creates thousands of individual storage executions, with one delete occupying 21.045 seconds.
Its SQL duration, unbounded workload, and truncate payload need their own boundedness fix,
independent of this peak-heap attribution.

## Artifacts

```text
/tmp/backoffice-peak-cause-idle.mjs
/tmp/backoffice-peak-cause-idle.json
/tmp/backoffice-peak-cause-gc-checkpoints.mjs
/tmp/backoffice-peak-cause-gc-checkpoints-summary.json
/tmp/backoffice-peak-cause-gc-checkpoints-memory.tsv
/tmp/backoffice-peak-cause-turn.stdout
/tmp/backoffice-peak-cause-turn.stderr
/tmp/backoffice-peak-cause-outbox.ndjson
```
