# @fragno-dev/lofi-zql

Runs [ZQL](https://zero.rocicorp.dev/docs/reading-data) queries against a `@fragno-dev/lofi` SQLite
replica and keeps their results up to date incrementally (IVM) as outbox entries arrive, instead of
running them again. It plugs a view engine into lofi's replica worker (see "Replica worker and live
views" in lofi's README), which reads the replica synchronously from OPFS: operators read rows from
SQLite as they need them, so memory grows with the open views, not with the replicated tables.

```bash
pnpm add @fragno-dev/lofi @fragno-dev/lofi-zql @journeyapps/wa-sqlite
```

The worker serves the replica with the ZQL engine:

```ts
// replica.worker.ts
import { serveLofiSqliteWorker } from "@fragno-dev/lofi/sqlite/worker";
import { zqlViewEngine } from "@fragno-dev/lofi-zql/worker";

serveLofiSqliteWorker({
  replica: {
    baseUrl: "/api/my-fragment",
    fetch: fetch.bind(globalThis),
    schemas: [{ schema: appSchema }],
    localSchemas: [],
    projections: [],
    ephemeralTables: [],
    onError: (error) => console.error(error),
    retryDelayMs: 5_000,
  },
  engines: [zqlViewEngine],
});
```

The page queries one of the replica's schemas. A view's result is maintained while the view has
listeners, and SQL views of the same replica work alongside:

```ts
import { connectLofiSqlite } from "@fragno-dev/lofi/sqlite";
import { lofiZql } from "@fragno-dev/lofi-zql";

const worker = new Worker(new URL("./replica.worker.ts", import.meta.url), { type: "module" });
const replica = await connectLofiSqlite({ port: worker, schemas: [{ schema: appSchema }] });
const app = lofiZql(replica, appSchema);

const $posts = app.store(
  app.query.posts
    .whereExists("author", (author) => author.where("active", true))
    .related("author")
    .orderBy("title", "asc")
    .limit(20),
);
$posts.subscribe((result) => {
  // { status: "loading" } | { status: "ready", data } | { status: "error", message }
});
```

Tables and columns are named as in the Fragno schema, and rows hold the replica's values: the
external `id` (the primary key), `_internalId`, `_version`, dates and timestamps as epoch
milliseconds, and references as the referenced row's `_internalId`. Each reference column gives a
`one` relationship named like Fragno's forward relation (`authorId` → `author`). Binary columns are
left out, and an integer beyond `Number.MAX_SAFE_INTEGER` fails the view. Because the replica holds
whole tables, `NOT EXISTS` is allowed.

## How views stay current

The IVM operators are Zero's, vendored from [rocicorp/mono](https://github.com/rocicorp/mono) into
`src/vendor` by `scripts/vendor-zql.mjs`, which also lists the two patches applied to them. zqlite's
`TableSource` reads the replica through the worker's synchronous wa-sqlite connection.

An operator pushing a change reads other rows, and must see the database as it was before that
change. The replica has already committed the whole batch by then. So temporary triggers on the
connection record each touched row's values from before the batch, and the engine, which the leader
calls with the database locked, rewinds every source to those rows in an in-memory overlay and
pushes the changes one at a time. A change reads the rows it touches, not the tables: the scenario
tests fail if updating one of 200 rows reads 10 or more.

Temporary triggers see only their own connection's writes. That holds because only the leading tab's
worker opens the replica, and the engine runs on its connection.

Re-vendor from a checkout of mono with `node scripts/vendor-zql.mjs <path-to-mono>`.

## Risks and follow-ups

- **No `many` relationships.** Only references give relationships, so a user's posts are queried
  from `posts` by `authorId`, not with `related("posts")`.
- **Relationship name collisions.** Fragno renames a forward relation whose name another reference
  column already produced (`author2`); the ZQL types do not.
- **Upstream drift.** The vendored engine is pinned to the commit in `src/vendor/UPSTREAM`. Re-run
  the script to update it; it fails when a patch no longer applies.
- The replica worker's risks apply too; see lofi's README.

## Exports

- `@fragno-dev/lofi-zql`: `lofiZql` - ZQL queries of the replica, from the page.
- `@fragno-dev/lofi-zql/worker`: `zqlViewEngine` - the view engine the replica worker runs.
