# Lofi SQLite import benchmark

Replays a recorded outbox stream into `@fragno-dev/lofi/sqlite` in the browser and measures the
import. The Vite dev server acts as the backend: it serves `GET /fixture/_internal` and
`GET /fixture/_internal/outbox/stream` from the recording. The page mirrors the automations schema
from `apps/backoffice/app/fragno/automation/schema.ts`.

```bash
OUTBOX_JSONL=~/dev/fragno-fixtures/outbox-dl-2026-10-23/outbox.jsonl pnpm -C packages-private/lofi-sqlite-import-benchmark dev
```

Open http://localhost:5544 in Chrome.

- **Import** opens the replica and samples its outbox cursor every 500 ms until it reaches the last
  entry, then counts the rows per table. It reports open time, entries per second, how long reads
  wait while the writer imports, and origin storage usage. The replica is
  `window.lofiSqliteReplica`.
- **Download only** reads and parses the whole stream without SQLite, as a baseline.
- **Delete OPFS data** closes the replica and empties this origin's OPFS, so the next import starts
  from scratch. Reloading without deleting resumes from the stored cursor.
- **Copy results JSON** copies the fixture, user agent, and both runs with their samples.

## Production build and headless runs

The dev server reloads the page when a workspace package such as `packages/lofi/dist` is rebuilt,
which ends a run. For clean measurements, build the page and serve it with `serve.ts`, which needs
only Node 24 (it runs the TypeScript directly), so the build, `serve.ts`,
`outbox-fixture-server.ts`, `src/outbox-fixture.ts`, and `measure.ts` can be copied to another
machine.

```bash
pnpm -C packages-private/lofi-sqlite-import-benchmark build
node serve.ts dist ~/dev/fragno-fixtures/outbox-dl-2026-10-23/outbox.jsonl 5544
# In another shell: one import in headless Chrome with an empty OPFS, results JSON on stdout.
node measure.ts /usr/bin/google-chrome http://localhost:5544/ views   # or no-views
```

### On a boxd machine

`run-remote.ts` does all of the above on a running boxd machine: it builds, uploads the build to
`~/lofi-sqlite-benchmark` (the fixture only when its SHA-256 differs), installs Chrome if needed,
runs the imports, downloads each run's JSON to `results/<time>/`, and prints a summary.

```bash
pnpm -C packages-private/lofi-sqlite-import-benchmark measure:remote \
  --machine dev1 \
  --fixture ~/dev/fragno-fixtures/outbox-dl-2026-10-23/outbox.jsonl \
  --runs no-views,views  # optional; one "views" run by default
```

## Fixture format

The recording is an `/_internal/outbox/stream?protocol=1` response: a `started` frame followed by
`entry` frames, one per line. The server sends `caught-up` after the last entry and keeps the stream
open with heartbeats, like a live backend.

The outbox still writes `sandbox_instance` and `marketplace_ingestion`, which the schema removed, so
the page lists them as ephemeral tables. Otherwise the replica would reject them as unknown tables.
Mutations for other schemas, such as `workflows`, are skipped.
