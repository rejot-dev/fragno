# How to profile Backoffice Worker module initialization heap

Build and profile both production Worker bundles from the repository root:

```bash
pnpm --filter @fragno-apps/backoffice-rr heap:profile
```

The command runs each probe in three fresh Node processes and reports median heap deltas for:

- each source module retained in the production bundle;
- lazy CommonJS module initialization;
- each npm package, workspace package, and Backoffice source group.

Profile one Worker or change the run count when iterating:

```bash
pnpm --filter @fragno-apps/backoffice-rr heap:profile -- --worker objects --runs 5
pnpm --filter @fragno-apps/backoffice-rr heap:profile -- --worker web --runs 5
```

Write the complete result for comparison with a later revision:

```bash
pnpm --filter @fragno-apps/backoffice-rr heap:profile -- \
  --worker all \
  --runs 5 \
  --json /tmp/backoffice-worker-heap.json
```

Compare medians between revisions. Do not compare these absolute values with Workerd production heap
measurements.

## Why this probe starts from the Vite output

Backoffice does not deploy the source entry through Wrangler's esbuild bundler. The Cloudflare Vite
plugin produces `build/server` and `dist/rejot_backoffice`, and their generated Wrangler configs use
`no_bundle: true`. Running `wrangler deploy --dry-run --metafile` therefore either rebundles a
different source graph or only copies the already-built modules without producing useful source
metadata.

The profiler instead copies the exact production artifacts and instruments Rolldown's generated
`//#region <source-module>` boundaries after tree-shaking and chunking have completed. It also
instruments the generated lazy CommonJS helper so deferred CommonJS initialization is attributed to
the module named by its surrounding region.

The copied artifacts are loaded under Node with a minimal `cloudflare:workers` shim. The originals
under `build/` and `dist/` are not modified.

## Interpreting results

Use the module and package rankings to find cold-start candidates such as large schema catalogs,
static content, duplicated browser/server modules, and libraries initialized by every isolate. After
changing an import boundary or initialization strategy, rerun the same Worker with the same run
count.

The probe measures module evaluation, not request-time allocations. It does not exercise dynamically
imported chunks that the Worker entry does not load at startup. Use the Workerd inspector and heap
allocation sampling for request flows such as long Pi turns and Automations outbox streaming.
