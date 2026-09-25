# Workflow heap benchmark

This private package measures transient heap and sampled allocation while a Fragno workflow step
flushes streamed emissions through Durable Object SQLite.

## Build the benchmark

From the repository root:

```bash
pnpm exec turbo run build --filter=@fragno-private/workflows-heap-benchmark
```

## Compare short and long emission histories

```bash
pnpm --filter @fragno-private/workflows-heap-benchmark measure -- \
  --mode both \
  --histories 100,10000 \
  --runs 3 \
  --json benchmark-results/current.json
```

Each case starts a fresh local Wrangler process and uses a distinct Durable Object. Historical
emissions are seeded before measurement. The measured workflow then emits fixed-size batches over
multiple live-pump intervals and drains its step-emission cleanup. The result check requires that
only the previously seeded emissions remain; an incomplete durable-hook chain fails the benchmark.

## Pi-like measurement

Use this practical regression run to approximate the allocation pressure of a Pi workflow without
reproducing an entire approximately 100-second turn:

```bash
pnpm --filter @fragno-private/workflows-heap-benchmark measure -- \
  --mode allocation \
  --histories 100,10000 \
  --runs 3 \
  --batch-count 30 \
  --emissions-per-batch 10 \
  --payload-bytes 256 \
  --interval-ms 125
```

Each measured case lasts approximately 3.6 seconds. It compares the allocation cost of the same 300
new emissions and 30 flush opportunities against short and long pre-existing histories.

## Isolate terminal cleanup

Use the same Workerd harness to seed one terminal step scope and measure only its durable cleanup:

```bash
pnpm --filter @fragno-private/workflows-heap-benchmark measure -- \
  --workload cleanup \
  --mode both \
  --histories 100,10000 \
  --runs 3 \
  --batch-count 1 \
  --emissions-per-batch 1 \
  --payload-bytes 256 \
  --interval-ms 0 \
  --json benchmark-results/cleanup-current.json
```

For this workload, `--histories` is the number of emissions belonging to the cleanup target. The
harness schedules the real `onWorkflowStepEmissionsCleanup` hook and invokes one durable-hook alarm
per HTTP request, preserving the production 100-row page boundary while allowing event-loop and
runtime scheduling between attempts. The final-state check requires every seeded emission to be
deleted. Heap measurements retain `queryInstrumentation: null`; collect SQL diagnostics separately
so query timing objects do not contaminate the memory comparison.

## Fast peak-heap A/B check

For a directional check of a DB or workflow change, prepare two preinstalled worktrees that differ
only in the code being tested. Run this from **each** repository root, setting `VARIANT=baseline` in
one and `VARIANT=optimized` in the other:

```bash
VARIANT=baseline # Use optimized in the other worktree.
pnpm exec turbo run build --filter=@fragno-private/workflows-heap-benchmark --output-logs=errors-only
pnpm --filter @fragno-private/workflows-heap-benchmark measure -- \
  --mode heap --histories 1000 --runs 2 \
  --batch-count 30 --emissions-per-batch 10 \
  --payload-bytes 256 --interval-ms 110 \
  --json "/tmp/workflow-heap-fast-${VARIANT}.json"
```

Compare the printed median `peakDelta` and the **absolute peaks** at
`results[].measurement.peakUsedBytes` in both reports. Each run seeds 1,000 historical emissions,
then measures the same 300 new emissions in a fresh local Workerd process without allocation
sampling or forced GC during the run. Keep the arguments and Wrangler version identical. A full A/B
including worktree creation, offline installation, both builds, four runs, and cleanup took **63.979
s** on September 23, 2026; warm worktrees avoid that setup but timing is not guaranteed.

This is a quick **screen**, not a measurement of a full Backoffice model turn. Peak can depend on
history length and natural GC; confirm promising results at other history sizes and in comparable
production-preview turns before claiming a peak-heap win.

## Quick optimization loop

Use this configuration while iterating on workflow pump allocation behavior:

```bash
pnpm --filter @fragno-private/workflows-heap-benchmark measure -- \
  --mode allocation \
  --histories 100,10000 \
  --runs 1 \
  --batch-count 3 \
  --emissions-per-batch 10 \
  --payload-bytes 256 \
  --interval-ms 110
```

The measured streaming window is approximately 220 milliseconds per case, excluding Wrangler startup
and historical seeding. Three batches provide multiple live flushes without turning the regression
check into a soak test.

The production live pump runs every 100 milliseconds. The 110-millisecond interval lets each batch
cross a pump tick and be persisted while the workflow step is running. Setting the interval to zero
would collapse the emissions into a final flush and would not exercise the recurring historical
reread behavior.

The report contains:

- baseline, peak, and settled post-run Workerd heap usage;
- sampled allocation totals and largest call frames;
- the workflow's persisted completion result;
- median values across runs.

Use `--mode heap` while iterating on peak heap without allocation-profiler distortion. Use
`--mode allocation` to compare cumulative transient allocation.

## Options

```text
--workload <stream|cleanup>    Measured workflow phase (default: stream)
--mode <heap|allocation|both>  Measurement mode (default: both)
--histories <counts>           Comma-separated historical emission counts
--runs <count>                 Fresh Workerd processes per case (default: 1)
--batch-count <count>          Measured emission batches (default: 30)
--emissions-per-batch <count>  Emissions in each measured batch (default: 10)
--payload-bytes <count>        Payload string size (default: 256)
--interval-ms <count>          Delay between batches (default: 125)
--json <path>                  Write the complete report as JSON
--worker-port <port>           Wrangler HTTP port (default: automatically selected)
--inspector-port <port>        Workerd inspector port (default: automatically selected)
```

Do not compare these absolute values with Node heap measurements. Compare revisions using identical
arguments and the same Wrangler/Workerd version.
