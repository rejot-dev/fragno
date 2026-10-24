# @fragno-dev/lofi

Local-first client for Fragno. Lofi polls the Fragno DB outbox, applies mutations into a local
IndexedDB store, and exposes a read-only query engine that mirrors the server query builder.

## Who is this for?

- App authors integrating Fragno fragments who want fast local reads and offline-friendly access.
- Projects using `@fragno-dev/db` with the outbox endpoint enabled.

## What it does

- Polls `GET /_internal/outbox` and persists a cursor so sync resumes after reloads.
- Applies create/update/delete mutations to IndexedDB with idempotency.
- Provides a read-only query engine (`find`, `findFirst`, `findWithCursor`).
- Submits sync commands to `POST /_internal/sync` with optimistic local execution and rebase.

Out of scope (for now): custom conflict resolution UI and live reactive queries.

## Install

```bash
pnpm add @fragno-dev/lofi @fragno-dev/db
# or
npm install @fragno-dev/lofi @fragno-dev/db
```

## Quick start

### 1) Enable the outbox on the server

The outbox route is exposed by `@fragno-dev/db` when the database adapter has outbox enabled. Your
app must mount the internal `/_internal/outbox` route and keep it stable.

### 2) Create the local adapter + client

```ts
import { schema, idColumn, column } from "@fragno-dev/db/schema";
import { IndexedDbAdapter, LofiClient } from "@fragno-dev/lofi";

const appSchema = schema("app", (s) =>
  s.addTable("users", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .addColumn("age", column("integer"))
      .createIndex("idx_age", ["age"]),
  ),
);

const adapter = new IndexedDbAdapter({
  endpointName: "app",
  schemas: [{ schema: appSchema }],
});

const client = new LofiClient({
  outboxUrl: "https://example.com/_internal/outbox",
  endpointName: "app",
  adapter: baseAdapter,
});

// One-off sync:
await client.syncOnce();

// Or keep a polling loop running:
client.start();
```

### 3) Query locally

```ts
const query = adapter.createQueryEngine(appSchema);

const users = await query.find("users", (b) =>
  b.whereIndex("idx_age", (eb) => eb("age", ">=", 21)).orderByIndex("idx_age", "asc"),
);
```

## Recoverable ephemeral streams

Some outbox data is useful only while work is active. Persisting every intermediate row to IndexedDB
can be expensive, but simply dropping those rows makes an active view impossible to reconstruct
after a late mount or browser reload.

Lofi supports recoverable ephemeral streams for this case. Ephemeral mutations remain outside the
local database, while active streams are buffered in memory and remain recoverable through the
normal outbox endpoint.

### The invariant

For every active ephemeral stream:

> The persisted outbox checkpoint remains before the stream's start mutation until its durable end
> mutation has been processed.

This allows the network connection to continue following the latest outbox entries without losing
the position needed to rebuild active state after reload.

### Configuring a stream

An ephemeral table can provide a stream policy in addition to its schema and table names:

```ts
const runtime = createLofiRuntime({
  endpointName: "app",
  adapter,
  outboxUrl: "/api/_internal/outbox",
  outboxTransport: "stream",
  ephemeralTables: [
    {
      schema: "app",
      table: "operation_events",
      stream: {
        key: (values) => String(values["operationId"]),
        boundary: (values) => {
          if (values["type"] === "operation-start") {
            return "start";
          }
          if (values["type"] === "operation-committed") {
            return "end";
          }
          return "item";
        },
      },
    },
  ],
});
```

The policy has two responsibilities:

- `key(values)` returns the identity shared by every row belonging to one stream.
- `boundary(values)` classifies each created row as `start`, `item`, or `end`.

Tables without a `stream` policy retain ordinary ephemeral behavior: mutations are delivered live,
not stored, and the persisted cursor advances normally.

### Two cursors

Recoverable streams require two different cursor concepts.

#### Volatile read cursor

The read cursor advances after every successfully processed outbox entry. It controls the active
poll or `/stream` connection and prevents the running client from repeatedly downloading entries it
already saw.

This cursor exists only in memory. Network reconnects and stop/start cycles on the same client can
continue from it because the active stream buffers are still available.

#### Persisted replay checkpoint

The replay checkpoint is stored in adapter metadata and survives browser reloads. It is calculated
as:

- The versionstamp immediately before the earliest active stream, when any stream is active.
- The current read cursor when no streams are active.

A newly created client starts from this persisted checkpoint and reconstructs its active stream
buffers by reading the outbox again.

### Processing stream mutations

Lofi maintains an in-memory entry for each active stream:

```ts
type ActiveEphemeralStream = {
  startedAfterVersionstamp: string | undefined;
  startOrder: number;
  mutations: Array<{
    order: number;
    batch: LofiEphemeralMutationBatch;
  }>;
};
```

When a `start` mutation arrives, Lofi:

1. Records the read cursor from immediately before the containing outbox entry.
2. Creates or replaces the stream buffer.
3. Adds the start mutation as the first replayable item.

When an `item` mutation arrives, Lofi adds it to the matching active stream. Items without an active
start are still delivered live, but they cannot be replayed later.

When an `end` mutation arrives, Lofi:

1. Delivers the end mutation to current subscribers.
2. Removes the matching stream buffer.
3. Recalculates and persists the safe replay checkpoint.

The end mutation must only be emitted once the durable state that supersedes the stream is part of
the same committed operation. Otherwise, Lofi could advance its checkpoint before an authoritative
replacement exists.

### Delivery failures

The replay checkpoint and volatile read cursor advance only after ephemeral dispatch and stream
bookkeeping succeed. If a listener throws, the entry remains retryable while its durable mutations
are deduplicated by the adapter inbox.

Raw `LofiClient` listeners follow ordinary at-least-once delivery: if one throws, a retry can call
listeners that already completed. Stream-buffer actions are committed only after successful
dispatch, so transport retries do not duplicate buffered items.

Reducers attached through `runtime.store().withEphemeral(...)` are isolated at the store boundary. A
reducer exception is exposed through that store's `error` state and does not prevent another store
from receiving the mutation or allow a UI failure to block outbox synchronization.

### Late subscriptions

The runtime processes and buffers configured streams even when no component currently subscribes to
the ephemeral table.

When `runtime.subscribeEphemeral(...)` is called, Lofi:

1. Registers the listener for future live mutations.
2. Replays all matching active buffers in original mutation order.
3. Continues delivering new live mutations.

`runtime.store().withEphemeral(...)` uses this subscription. Replay can therefore arrive before the
store's first durable query finishes; the store queues those mutations, performs its durable
retrieval, reduces the queued stream, and overlays the result.

A list page can keep one shared runtime consuming the outbox while a detail page is unmounted. When
the detail page mounts later, it receives the active stream from its start rather than only
receiving new deltas from that point onward.

### Bootstrap delivery gate

A fresh local database may need to scan a large outbox history. Delivering every historical
ephemeral row to mounted stores would make each store queue unrelated creates while its durable
retrieval waits for bootstrap to finish.

During finite bootstrap catch-up, Lofi therefore separates stream reconstruction from subscriber
delivery:

1. The client processes durable mutations and all ephemeral stream boundaries.
2. Historical ephemeral mutations are not sent to live subscribers.
3. Completed stream buffers are discarded as their end boundaries are encountered.
4. Once catch-up reaches the current outbox head, only still-active buffers are replayed.
5. The runtime becomes bootstrapped, durable stores retrieve their rows, and normal live delivery
   begins.

This bounds each store's pre-retrieval queue to currently active replayable streams instead of the
entire historical ephemeral table. Ordinary ephemeral tables without a stream policy have no
recoverable history and their bootstrap-time mutations are intentionally not delivered.

When a persisted bootstrap marker already exists but recoverable streams are configured, a new
runtime still performs this finite catch-up. The persisted replay checkpoint may intentionally be
behind the outbox head, so skipping catch-up would leave the active in-memory buffers empty.

### Reload and reconnect recovery

Suppose a browser has processed an active stream through version `v150`, but its persisted replay
checkpoint remains at `v099` because the stream began at `v100`.

After a browser reload:

1. A new Lofi client reads `v099` from adapter metadata.
2. A finite outbox sync catches up from `afterVersionstamp=v099` without delivering historical
   ephemeral rows.
3. Durable mutations encountered during replay are deduplicated by the adapter inbox.
4. Ephemeral mutations are still processed even when the durable part of an entry was already
   applied.
5. The start mutation at `v100` recreates the active buffer.
6. Subsequent items rebuild the current transient state through `v150`.
7. At the catch-up boundary, Lofi replays only the active buffer to subscribers.
8. The live poll or `/stream` connection continues from the volatile read cursor.

No separate snapshot endpoint or additional detail request is required. Recovery uses the normal
outbox route and then transitions to the configured live transport without a versionstamp gap.

### Concurrent streams

Streams are buffered independently. Only the earliest active start determines the persisted replay
checkpoint.

For example:

```txt
v100  workflow A starts
v120  workflow B starts
v200  workflow A commits
v300  workflow B commits
```

The persisted checkpoint moves as follows:

```txt
A active             -> immediately before v100
A and B active       -> immediately before v100
A commits, B active  -> immediately before v120
B commits            -> v300
```

Closing one stream does not discard or corrupt another stream. A reload may replay unrelated durable
entries between the checkpoint and the read head, but those writes are idempotently ignored while
the still-active ephemeral streams are reconstructed.

Memory usage is proportional to the emissions belonging to currently active streams. A stream that
never emits an end boundary intentionally keeps its checkpoint pinned and remains buffered; exact
recovery cannot safely discard it without an authoritative durable replacement.

### Pi Harness workflow mapping

Pi Harness uses this mechanism for compact assistant-message deltas. Its workflow emission rows are
identified by:

```txt
instanceRef + stepKey + epoch
```

`epoch` is required because a retry can reuse the same logical operation ID.

The operation opens with:

```ts
{
  kind: "harness-operation-start",
  operationId,
  operation,
  replay: {
    protocol: "pi-harness-operation",
    version: 1,
  },
}
```

Intermediate `harness-event`, `harness-message-update`, `harness-session-entry`, and
`harness-operation-complete` emissions remain buffered as stream items.

The workflows runner writes a system emission with the durable workflow-step mutation:

```ts
{
  control: "step-committed",
  epoch,
}
```

That emission is the stream's `end` boundary. The earlier `harness-operation-complete` emission only
means the harness callback finished; it is not the durable boundary. Once `step-committed` is
processed, the persisted `workflow_step.result` can reconstruct the session and the transient buffer
can be discarded.

Pi Harness exports its complete table policy, so applications do not need to reproduce these
protocol checks:

```ts
import { piWorkflowStepEmissionEphemeralTable } from "@fragno-dev/pi-harness/client/pi-workflow-emission-stream";

const runtime = createLofiRuntime({
  // ...
  ephemeralTables: [piWorkflowStepEmissionEphemeralTable],
});
```

This keeps compact message updates out of IndexedDB, supports multiple active workflows on one
shared runtime, and lets a session projection mount or reload midway through generation without
losing the initial message-start event or any preceding deltas.

## Submit (sync commands)

Lofi can submit write commands to the server and replay confirmed commands locally.

### 1) Define sync commands on the server

```ts
import { defineFragment } from "@fragno-dev/core";
import { defineSyncCommands, withDatabase } from "@fragno-dev/db";
import { schema, idColumn, column } from "@fragno-dev/db/schema";

const appSchema = schema("app", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const syncCommands = defineSyncCommands({ schema: appSchema }).create(({ defineCommand }) => [
  defineCommand({
    name: "createUser",
    handler: async ({ input, tx }) => {
      const payload = input as { id: string; name: string };
      await tx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("users", payload);
        })
        .execute();
    },
  }),
]);

const fragment = defineFragment("app")
  .extend(withDatabase(appSchema))
  .withSyncCommands(syncCommands)
  .build();
```

### 2) Queue + submit commands on the client

```ts
import { LofiSubmitClient } from "@fragno-dev/lofi";

const submit = new LofiSubmitClient({
  endpointName: "app",
  submitUrl: "https://example.com/_internal/sync",
  internalUrl: "https://example.com/_internal",
  adapter,
  schemas: [appSchema],
  commands: [
    {
      name: "createUser",
      target: { fragment: "app", schema: appSchema.name },
      handler: async ({ input, tx }) => {
        await tx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("users", input as { id: string; name: string });
          })
          .execute();
      },
    },
  ],
});

await submit.queueCommand({
  name: "createUser",
  target: { fragment: "app", schema: appSchema.name },
  input: { id: "user-1", name: "Ada" },
  optimistic: true,
});

const response = await submit.submitOnce();
```

## Optimistic overlay (optional)

Lofi ships an in-memory optimistic overlay for cases where you want a deterministic, replayable view
of queued sync commands layered on top of the persisted IndexedDB state.

- **Base state** lives in IndexedDB and only changes via outbox sync (`LofiClient`) or submit
  responses (`submitOnce`).
- **Overlay state** is in-memory and rebuilt by replaying queued commands. It no longer relies on
  IndexedDbAdapter snapshot export APIs.
- **Durability**: the submit queue is persisted in IndexedDB meta, but the overlay store is
  ephemeral. After reloads, call `rebuild()` to restore the optimistic view.
- **Rebase flow**: when `submitOnce()` returns, confirmed command ids are removed from the queue and
  outbox entries are applied to the base adapter. Rebuilding the overlay replays only the remaining
  queued commands.

### Stacked adapter composition

The optimistic overlay is powered by `InMemoryLofiAdapter` plus `StackedLofiAdapter`. The stacked
adapter merges a persisted base (IndexedDB) with the in-memory overlay so reads reflect optimistic
commands.

```ts
import { IndexedDbAdapter, InMemoryLofiAdapter, StackedLofiAdapter } from "@fragno-dev/lofi";

const baseAdapter = new IndexedDbAdapter({
  endpointName: "app",
  schemas: [{ schema: appSchema }],
});

const overlayAdapter = new InMemoryLofiAdapter({
  endpointName: "app",
  schemas: [appSchema],
});

const stackedAdapter = new StackedLofiAdapter({
  base: baseAdapter,
  overlay: overlayAdapter,
  schemas: [appSchema],
});
```

```ts
import { LofiOverlayManager } from "@fragno-dev/lofi";

const overlay = new LofiOverlayManager({
  endpointName: "app",
  adapter,
  schemas: [appSchema],
  commands: [
    {
      name: "createUser",
      target: { fragment: "app", schema: appSchema.name },
      handler: async ({ input, tx }) => {
        await tx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("users", input as { id: string; name: string });
          })
          .execute();
      },
    },
  ],
});

await overlay.rebuild();
const optimisticQuery = overlay.stackedAdapter.createQueryEngine(appSchema);
const optimisticUsers = await optimisticQuery.find("users");
```

Use `overlay.stackedAdapter` for optimistic reads/writes (for example, in `LofiSubmitClient`). Use
the base adapter directly for `LofiClient` so outbox sync only touches persisted state.

## Local schemas / materialized views

Adapters can register read-only local schemas and projection functions. Projections run after server
mutations are applied and before the adapter transaction commits, so canonical rows and local view
rows stay in sync. Each projection runs once per applied mutation batch. It has a synchronous
`retrieve` phase that declares local rows to read, followed by a synchronous `mutate` phase that
receives the retrieved snapshot and queues local writes.

```ts
const userCardsSchema = schema("local_user_cards", (s) =>
  s.addTable("cards", (t) =>
    t.addColumn("id", idColumn()).addColumn("displayName", column("string")),
  ),
);

const adapter = new IndexedDbAdapter({
  endpointName: "app",
  schemas: [{ schema: appSchema }],
  localSchemas: [{ schema: userCardsSchema }],
  projections: [
    {
      retrieve: ({ match, read }) =>
        read
          .each(match.all(appSchema, "users", ["create", "update"]))
          .map((mutation) => {
            const name = mutation.op === "create" ? mutation.values.name : mutation.set.name;
            return typeof name === "string" ? { mutation, name } : undefined;
          })
          .get(userCardsSchema, "cards", ({ mutation }) => mutation.externalId),
      mutate: ({ match, retrieved, tx }) => {
        const cards = tx.forSchema(userCardsSchema);
        for (const mutation of match.all(appSchema, "users", "delete")) {
          cards.delete("cards", mutation.externalId);
        }
        for (const {
          item: { mutation, name },
          row: existing,
        } of retrieved) {
          const values = { displayName: name };
          if (existing) {
            cards.update("cards", mutation.externalId, (b) => b.set(values));
          } else {
            cards.create("cards", { id: mutation.externalId, ...values });
          }
        }
      },
    },
  ],
});

const cards = await adapter
  .createQueryEngine(userCardsSchema)
  .find("cards", (b) => b.whereIndex("primary"));
```

Local schemas are client-only and read-only from the server's perspective: they are not valid sync
command targets and are only written by projection code. Projection reads are intentionally limited
to local schemas, so projections behave like reducers over applied mutations plus projection-owned
state. Projection `retrieve`/`mutate` functions must not return promises; adapters own all async
IndexedDB work to keep transactions active. If local schema or projection code changes, delete the
whole IndexedDB database and sync again.

## SQLite replica (browser)

`@fragno-dev/lofi/sqlite` mirrors one backend's outbox into a SQLite database in the browser's
Origin Private File System (OPFS), using the same wa-sqlite setup as
`@fragno-dev/tanstack-db-adapter`. Tables are laid out like the backend's SQLite tables, so you read
them with plain SQL. Local projections run in the same transaction as the outbox entry. The replica
only receives server state: it has no query engine, no optimistic writes, and no submit.

```bash
pnpm add @tanstack/browser-db-sqlite-persistence @journeyapps/wa-sqlite
```

```ts
import { openLofiSqliteReplica } from "@fragno-dev/lofi/sqlite";

const replica = await openLofiSqliteReplica({
  baseUrl: "https://example.com/api/my-fragment", // serves /_internal
  fetch: fetch.bind(globalThis),
  schemas: [{ schema: appSchema }],
  // Projections work as in "Local schemas / materialized views" below.
  localSchemas: [],
  projections: [],
  ephemeralTables: [],
  onError: (error) => console.error(error),
  retryDelayMs: 5_000,
});

const { users } = appSchema.tables;
const load = () =>
  // Each result column decodes like the schema column it names, or as a plain integer or text.
  replica.query({
    sql: `SELECT "id", "email", "joinedAt", count(*) OVER () AS "total"
          FROM "users_app" WHERE "age" >= ?1 ORDER BY "age"`,
    params: [21],
    columns: {
      id: "text",
      email: users.columns.email,
      joinedAt: users.columns.joinedAt,
      total: "integer",
    },
  });

const unsubscribe = replica.subscribe(() => void load());
// On teardown:
unsubscribe();
await replica.close();
```

### Layout

- **Tables** are named like the backend's: `<table>_<namespace>`, where the namespace is the schema
  name the outbox reports (`app` above). Use `lofiSqliteTableName({ schema }, "users")` rather than
  hard-coding names. Local schemas follow the same rule.
- **Columns** use the schema's column names, including `_internalId` (a local
  `INTEGER PRIMARY KEY AUTOINCREMENT`, not the server's id), `id` (the external id) and `_version`
  (starts at 0 and goes up by 1 on every update, as on the server).
- **Reference columns** hold the referenced row's local `_internalId`, so joins work as on the
  server: `JOIN "users_app" u ON p."authorId" = u."_internalId"`.
- **Values** are stored as on the backend's SQLite: dates and timestamps as epoch milliseconds,
  booleans as 0/1, JSON as text, binary as BLOB. Bigints are the exception: they are stored as
  `INTEGER`, not as an 8-byte BLOB, so they compare and sort numerically. wa-sqlite returns an
  integer as a `number` when it is a safe integer and as a `bigint` otherwise.
- **Indexes** have the backend's names. All of them are non-unique: a row the server deleted with
  `omitOutbox()` and no truncate notification stays in the replica, and a new row may reuse its
  unique values. There are no foreign keys, because a replica may mirror only some schemas.
- `replica.query({ sql, params, columns })` decodes each result column like the schema column it
  names (a `Date`, boolean, parsed JSON, or bigint), or as a plain `"integer"` or `"text"`, which
  must not be NULL. A declared column missing from the result throws.
  `decodeLofiSqliteRow(table, row)` restores a whole row in the record shape of a Fragno query: a
  `FragnoId` for `id`, a `FragnoReference` for references, and decoded values.
- **Parameters**: whole numbers bind as 64-bit integers. wa-sqlite would bind a number outside the
  32-bit range, such as a timestamp, as REAL, so `("occurredAt" - ?) / ?` would divide in floating
  point.
- `lofi_meta` holds the outbox cursor, and `lofi_inbox` holds the entries already applied.

Mutations for schemas you did not register are skipped. A mutation for an unknown table in a
registered schema fails, because it means the client's schema is behind the server's. Rows of
`ephemeralTables` are skipped, not stored.

### Database name and schema changes

The database is a replayable cache, so it is never migrated. Its OPFS file name is
`fragno-lofi-<hash>.sqlite`, where the hash covers the normalized base URL, the backend's
`adapterIdentity` (from `GET /_internal`), `LOFI_SQLITE_LAYOUT_VERSION`, and the name and version of
every registered source and local schema. Changing any of them opens a fresh database, which replays
the outbox from the start.

### Tabs

Every tab opens its own connection and reads through it. One tab at a time holds a Web Lock named
after the database. That tab streams the outbox (`GET /_internal/outbox/stream`) and writes. It
releases the lock only after its last transaction has finished, so two tabs never write at once.
When it closes, the next tab acquires the lock and resumes from the cursor in `lofi_meta`. If its
synchronization stops on an error, for example an HTTP error from the stream, it reports the error
to `onError`, releases the lock so another tab can try, and competes again after `retryDelayMs`.

The writing tab applies the entries that have arrived, up to 50 at a time, in one transaction that
also writes the cursor once, so a catch-up commits once per batch instead of once per entry. An
entry that fails, for example because a projection throws, rolls back its whole batch, and the next
attempt starts from the batch's first entry.

The writing tab tells the other tabs over a `BroadcastChannel` once a batch commits; `subscribe`
fires in every tab. `execute` waits for the tab's pending replication writes, so a read never sees
half of a batch.

### Risks and follow-ups

- **The OPFS path has no automated test.** The scenario tests run the whole replica in Node against
  fragno-db's SQLite backend, with wa-sqlite's in-memory VFS standing in for OPFS and Node's own Web
  Locks and `BroadcastChannel`. That VFS does not lock, so the tests do not show how tabs contend
  for the file. The real OPFS path was checked by hand in Chrome 130 through the SQLite replica tab
  of `example-apps/react-spa-local-first`: catch-up, live updates in two tabs, takeover when the
  writing tab closes, persistence across a reload, and projections. Chrome can grant a Web Lock
  request after its signal aborted; the replica handles that, and a scenario simulates it.
- **No offline start.** `openLofiSqliteReplica` fetches `GET /_internal` before opening the
  database, because the database name depends on the backend's `adapterIdentity`. While the backend
  is unreachable, opening fails even when the data is already in OPFS. Remembering the last database
  name per base URL would let a tab open the existing replica and start synchronizing once the
  backend is back.
- **Reads in other tabs during heavy writes.** OPFSCoopSyncVFS hands file access between
  connections. If reading tabs stall while the writing tab catches up, send their reads to the
  writing tab over the `BroadcastChannel` instead, as `@fragno-dev/tanstack-db-adapter` does.
- **Catch-up speed.** Batches remove most commits, but every statement is still a round trip to the
  worker, including each entry's inbox check and write.
- **Projection changes.** Changing projection code does not change the database name, so rows
  projected by the old code stay until a registered schema's version changes. A projection version
  in the database name would fix this.
- **Growth.** `lofi_inbox` rows are never pruned, and databases left behind by a name change stay in
  OPFS. Both need cleanup.
- **Exact checkpoints.** The cursor is a versionstamp, as in `LofiClient`, with `lofi_inbox`
  removing duplicates. `@fragno-dev/tanstack-db-adapter` resumes from `{versionstamp, uowId}` and
  rejects a history it cannot verify; the replica does not.
- **Dangling references.** A reference to a row the replica does not hold, for example in a table
  you did not register, is stored as NULL and is not filled in if the row arrives later.
- **Errors that never clear.** A schema mismatch fails on every attempt, so each tab retries every
  `retryDelayMs` and reports the same error each time. The entries before the failing one in its
  batch are not applied either.
- **No snapshot across queries.** Each `execute` or `query` waits for pending writes, but the
  writing tab can apply an entry between two of a reader's queries, so a view built from several
  queries can mix states. The next change notification reads again. A read transaction would need
  its own connection, because replication writes share the tab's.
- **Coarse refresh.** `subscribe` says only that something changed, not which tables. Sending the
  changed tables would let readers skip unrelated queries.
- **JSON `null`.** A JSON column holding `null` is stored as SQL `NULL`, the same as a missing
  value.

## Notes

- `endpointName` must match between `LofiClient` and `IndexedDbAdapter`.
- The adapter stores data in one IndexedDB database (default name: `fragno_lofi_<endpointName>`).
- If the registered schema changes, Lofi clears local rows for that endpoint and re-syncs.
- `outboxUrl` can include query parameters; Lofi preserves them when adding cursor/limit params.

## CLI

Lofi ships with a small CLI that polls an outbox for a short window and prints the local IndexedDB
state as JSON (useful for demos/tests).

```bash
# From the workspace
pnpm -C packages/lofi build
node packages/lofi/bin/run.js --help
```

```bash
# Use the CLI
fragno-lofi --endpoint http://localhost:3000/api/fragno-db-comment --module ./client.ts --timeout 5
```

Notes:

- `--endpoint` can be the fragment base URL or the full `/_internal/outbox` URL.
- Use `--endpoint-name` to override the local endpoint key used for IndexedDB storage.
- `--module` is required and must export `schema` or `schemas` (and optional `commands`).

Example `client.ts` module:

```ts
import { schema, idColumn, column } from "@fragno-dev/db/schema";

export const schema = schema("app", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);
```

## Exports

- `LofiClient` - polls outbox and applies entries.
- `IndexedDbAdapter` - IndexedDB-backed `LofiAdapter` and query engine.
- `InMemoryLofiAdapter` - in-memory `LofiAdapter` for optimistic overlays/tests.
- `StackedLofiAdapter` - merges base + overlay adapters for optimistic reads.
- `@fragno-dev/lofi/sqlite`: `openLofiSqliteReplica`, `SqliteLofiAdapter`, `decodeLofiSqliteRow`,
  `lofiSqliteTableName` - the browser SQLite replica.
- `@fragno-dev/lofi/sqlite/testing`: `openLofiSqliteMemoryFiles` opens replicas in Node on
  wa-sqlite's in-memory VFS, and `waitForLofiSqliteReplica` waits until a replica reaches a
  versionstamp - for scenario tests of apps that read a replica.
- `LofiOverlayManager` - overlay manager that rebuilds queued optimistic commands.
- Outbox helpers: `decodeOutboxPayload`, `resolveOutboxRefs`, `outboxMutationsToUowOperations`.
- Types: `LofiClientOptions`, `LofiAdapter`, `LofiMutation`, `LofiQueryInterface`, and more.
