# How to benchmark Backoffice streaming peak heap

Use one command to build and benchmark a local production-preview Backoffice turn. It runs the
fixed-workload Workerd workflow benchmark, three separate **heap-only** Pi turns, and one separate
allocation-sampled turn. It writes an owner-only JSON report and an adjacent artifacts directory.

From the repository root, configure a model key and `AUTH_ADMIN_GRANT_TOKEN` in
`apps/backoffice/.dev.vars`. The benchmark creates or reuses a **local** `@rejot.dev` account and
grants it administrator access **only on localhost**. By default it uses `${USER}@rejot.dev` and the
development password `wachtwoord`, matching `create-dev-account.sh`:

```bash
pnpm --filter @fragno-apps/backoffice-rr benchmark:streaming-heap -- \
  --json /tmp/backoffice-streaming-heap-2026-09-23.json
```

These are known, weak **local-development-only** credentials. Never reuse them on an exposed server.
To override either default, set `BACKOFFICE_EMAIL` and/or `BACKOFFICE_PASSWORD` before running the
command; for example, `read -rs BACKOFFICE_PASSWORD; export BACKOFFICE_PASSWORD; echo`.

On the first run, approve the CLI OAuth device login in the browser using that account. Later runs
reuse a dedicated credential file at
`~/.local/state/fragno/backoffice-cli/streaming-heap-benchmark-auth.json`. Override it with
`BACKOFFICE_AUTH_FILE` if needed. If another account is stored there, the command asks for a fresh
device approval. The account's password and the grant token are never written to the JSON report. If
an admin already exists and this account's email is unverified, the local admin-grant endpoint
rejects promotion; resolve verification before retrying.

The command owns ports `5173` (preview) and `9229` (Workerd inspector); stop any existing server or
DevTools session first. A new `--json` path is required on each invocation. It writes the report
there and raw profiles, listener output, trace IDs, and diagnostic logs in a sibling `.artifacts`
directory. Raw artifacts may contain model or outbox content; both the JSON file and artifacts are
owner-only and should normally stay under `/tmp`.

For a shorter iteration using already-built bundles:

```bash
pnpm --filter @fragno-apps/backoffice-rr benchmark:streaming-heap -- \
  --json /tmp/backoffice-streaming-heap-next.json \
  --skip-build --skip-isolated --heap-only --runs 1
```

Options: `--runs N`, `--post-ms N` (default: 60,000), `--turn-timeout-ms N` (default: 300,000;
maximum: 300,000), `--model PROVIDER:NAME`, `--scope org:SLUG`, `--prompt-file PATH`,
`--skip-build`, `--skip-isolated`, and `--heap-only`. The default model is `openai:gpt-5.6-luna`;
the bounded long-poem prompt targets 150 stanzas and 28,000–32,000 characters. The earlier unbounded
prompt kept streaming past the former 120-second codemode limit. Keep the prompt hash and output
length comparable across revisions. The report includes commit and dirty-worktree state, output
characters per turn, outbox records/bytes, the cleanup's first/final markers and delete-bearing
alarm traces, baseline and peak used JS heap, the median heap-only peak, and whether the heap-only
outputs meet the 20,000-character and 80%-of-longest comparability checks. It records partial
results and an error if a run fails; the command exits nonzero. The listener remains active until it
has received the committed outbox versionstamp (up to 60 seconds), so slow delivery cannot produce a
partial outbox summary. Preview and listener processes are stopped on completion or interruption.
The Pi wait deadline is 10 seconds shorter than the codemode request deadline so a slow turn reports
a Pi wait error rather than the sandbox's generic execution timeout. The profiler gives the cleanup
markers another minute. A model that exceeds even this bounded window requires a shorter prompt;
failed attempts should not be counted as completed benchmarks.

**Interpretation:** `heapOnlyMedianPeakUsedBytes` is the primary natural-GC measure. The profiler
forces GC _before_ a turn, never during the measured turn. Model output varies; compare runs with
similar output characters and the same model, listener count, code, and instrumentation state.
Sampled allocation is cumulative and does not measure simultaneously live heap. The sampled
`streaming` window can include cleanup allocations because CDP sampler switches lag console markers;
do not attribute its stacks to a precise phase without separate fixed-workload measurements. The
JSON cleanup result reports marker-to-marker wall time, longest SQLite storage transaction, alarm
count, and longest outer alarm span. The trace check waits for the alarm containing the final
cleanup console call to close and for its storage transactions to finish; incomplete terminal traces
fail the run. **An outer alarm span may remain open after SQL finishes** and must not be used as
cleanup SQL duration. The final observed storage transaction must finish **within the heap sampling
window**; otherwise increase `--post-ms` and rerun. Reported DELETE-span counts may be truncated by
local tracing and are not a count of all deleted rows.
