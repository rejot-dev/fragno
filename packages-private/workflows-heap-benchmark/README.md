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
multiple live-pump intervals.

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
