# Measure streaming allocations and peak Workerd heap

For a single command that builds preview, provisions a local account, runs repeated heap-only and
sampled turns, waits for terminal storage cleanup, and writes a JSON report, see
[`benchmark-streaming-heap.md`](benchmark-streaming-heap.md). The instructions below describe the
lower-level profiler for manually prepared turns.

**Primary success criterion: reduce peak JS heap in a production-preview, heap-only run without
forcing GC during the turn.** A lower sampled-allocation total, shorter cleanup, or lower post-GC
heap alone does not close the streaming-outbox peak-heap issue.

Run from the repository root after building Backoffice and starting
`pnpm --filter @fragno-apps/backoffice-rr preview`. Preview exposes `rejot-backoffice` on the
Workerd inspector at `http://localhost:9229`. Start **one** authenticated outbox listener
separately, use a fresh Pi session, and keep the prompt, model, output length, and listener count
comparable across runs. See
[`../open-issues/2026_09_02-streaming-outbox-peak-heap.md`](../open-issues/2026_09_02-streaming-outbox-peak-heap.md)
for the preview build, listener, and Pi CLI prerequisites.

The profile command wraps your existing turn command (`<turn command and args>`):

```bash
node apps/backoffice/scripts/profile-streaming-heap.mjs \
  --mode sampled --output /tmp/streaming-sampled -- <turn command and args>

node apps/backoffice/scripts/profile-streaming-heap.mjs \
  --mode heap-only --output /tmp/streaming-heap-only -- <turn command and args>
```

For example, the command after `--` can be
`pnpm --filter @rejot-dev/backoffice-cli run backoffice-cli exec <your-scope> --file <your-turn-script> --timeout 120000`.
Use separate fresh sessions and unique output prefixes. The post-cleanup window lasts 30 seconds by
default; use `--post-ms` before `--` to change it. The cleanup-marker deadline defaults to 3
minutes; use `--marker-timeout-ms` before `--` for longer turns. The wrapper writes `.summary.json`,
`.memory.tsv`, `.stdout`, `.stderr`, and (in sampled mode) `.streaming.allocation.json`,
`.cleanup.allocation.json`, and `.post-cleanup.allocation.json`. The summary includes
`startedAtEpochMs` for correlating marker offsets with completed storage traces, sampled bytes, and
top **full allocation stacks** per labeled window. The cleanup markers now bracket the **entire
durable cleanup chain**: the first hook emits `started` and the final page emits `completed`.
**`completed` still marks callback return, not the end of its outer alarm/storage trace.**
`post-cleanup` can therefore still include finalization work. Use storage-transaction end times, not
an outer alarm's potentially idle lifetime, for the SQL boundary. Stopping and restarting the CDP
sampler can also miss allocations during a short callback. An outbox truncate frame is not a
cleanup-completion marker.

The 100 ms `Runtime.getHeapUsage` samples are taken in both modes. **Use the heap-only run for the
absolute baseline and natural-GC peak**; sampled mode distorts heap usage. A baseline GC and console
discard occur _before_ starting the command, never during its measured turn. Do not keep DevTools
open at the same time: Workerd permits one inspector connection. The wrapper requires one matching
step-completed marker followed by cleanup-start and cleanup-complete markers; it fails on missing
markers rather than silently assigning phases.

Correlate the profile with compact production logs (no per-emission payload logging):

- `fragno.workflow_step_emissions.completed`: enqueued emission count, successful pump flushes,
  empty flushes, step key, and step attempt duration. The emission count is **enqueued**, not a byte
  count or a guarantee of distinct persisted rows.
- `fragno.workflow_step_emissions_cleanup.started` / `.completed`: step key, wall duration, emission
  and outbox-mutation deletion counts; it measures cleanup separately from streaming.
- `fragno.outbox_stream.completed`: polls and records read, plus frames and UTF-16 **characters**
  written, largest frame, and heartbeats. Characters are not wire bytes; no extra serialization is
  performed to estimate bytes.

Backoffice passes `queryInstrumentation: null` to the Durable Object dialect, so it does not measure
query rows or timing for console logs. The dialect still supports opt-in instrumentation; use
storage traces for SQL work in these profiles without enabling it on the production path.

Compare the **same output scale** before and after any optimization: peak heap (heap-only), sampled
allocation by phase and stack (sampled), storage spans, outbox frame characters, and settled heap.
Optimize paths contributing to the natural-GC peak, not merely cumulative allocation or slow cleanup
SQL. Console retention, sampling overhead, and multiple listeners must be controlled between runs.
Keep profiler settings identical across an A/B comparison.
