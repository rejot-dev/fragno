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
whole IndexedDB database and sync again. The SQLite replica can rebuild a projection from the rows
it stores instead; see "Rebuildable projections" below.

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

`replica.getStatus()` says whether the replica holds the data the backend had when synchronization
started, so views can wait for it instead of showing a partial history:

```ts
const stopWatching = replica.subscribeStatus(() => {
  const status = replica.getStatus();
  if (status.phase === "catching-up") {
    // `fraction` is null until the server names how much there is to replay.
    showProgress(status.fraction === null ? null : Math.floor(status.fraction * 100));
  } else {
    void load();
  }
  // The last synchronization failure, if any; the writing tab retries on its own.
  showError(status.error);
});
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
- `lofi_meta` holds the outbox cursor and the versionstamp of the last entry applied. An outbox
  delivers unique versionstamps in ascending order, so entries at or below it are skipped. The
  cursor can stay behind that while an ephemeral stream is open, and the entries after it then
  arrive again.

Mutations for schemas you did not register are skipped. A mutation for an unknown table in a
registered schema fails, because it means the client's schema is behind the server's. Rows of
`ephemeralTables` are skipped, not stored.

### Database name and schema changes

The database is a replayable cache, so it is never migrated. Its OPFS file name is
`fragno-lofi-<hash>.sqlite`, where the hash covers the normalized base URL, the backend's
`adapterIdentity` (from `GET /_internal`), `LOFI_SQLITE_LAYOUT_VERSION`, and the name and version of
every registered source schema and of every local schema that a projection without `rebuild` writes.
Changing any of them opens a fresh database, which replays the outbox from the start. Local schemas
written only by rebuildable projections are left out, because the replica rebuilds those in place.

### Rebuildable projections

A projection that declares `rebuild` can change without a new download. It names its version, the
source tables it reads, and the local tables it alone writes:

```ts
const postCounts = defineLocalProjection({
  ...countPostsPerAuthor, // its `retrieve` and `mutate`
  name: "post-counts", // required with `rebuild`
  rebuild: {
    version: 2, // bump when it writes different rows for the same input
    from: [{ schema: appSchema, table: "posts" }],
    writes: [{ schema: statsSchema, table: "authorStats" }],
  },
});
```

`lofi_meta` stores, per projection, its version, its source tables, and the statements that create
its tables. When the replica opens, and in each write transaction before its first entry, a
projection whose stored value differs is rebuilt in that transaction: its tables are dropped and
created again, and the projection runs on the stored rows of `from`, table by table in the order the
replica stored them, which is the order the outbox delivered them, 500 rows per call. So changing a
table's columns or indexes rebuilds on its own; changing what the projection computes needs a
version bump. Checking costs no database call of its own: the transaction's first read fetches the
stored values with the applied-through watermark. A writer still running older code rebuilds to its
own version before it applies anything, so a table never holds rows of two versions; two tabs on
different versions rebuild each time the writer changes.

Replayed rows arrive as `create` mutations with decoded values, and references as the referenced
row's external id, as from the outbox; `source.versionstamp` is empty. That reproduces what the
outbox built when:

- the projection gives the same rows however its input is split into calls;
- the rows it reads are never deleted, and never updated in what it reads;
- its references point at rows the replica holds: one the replica stored as NULL arrives as null.

A projection that folds events which are never deleted fits; one over rows that are updated or
deleted does not, and should leave `rebuild` out. A projection with `rebuild` may write only the
tables it lists, and two projections may not list the same table. Only the SQLite replica rebuilds;
other adapters ignore `rebuild` except for checking what it writes.

`rebuildLofiSqliteProjections` from `@fragno-dev/lofi/sqlite/testing` rebuilds a replica's
projections on a second connection and returns their tables before and after, so a test can check
that a projection rebuilds to the rows the outbox built.

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

Every call to the database is a round trip to its worker, which in a busy page cost more than the
statements themselves. Inside a transaction, statements that return no rows queue with their
parameters written in as SQL literals, and go to the worker in one call together with the next read
or the `COMMIT`; `BEGIN` goes with the first one. A batch takes two calls: one that begins it and
reads the applied-through watermark, and one with its writes and the commit. A value whose literal
SQLite could read back differently, such as a fraction or a number beyond 32 bits that is not a
bigint, sends its statement on its own. Calls go to the database one at a time, in the order they
were made: the worker starts each call as it arrives, so a projection's second read, sent while the
call carrying the queued writes was still running, could otherwise miss them. Replaying a
6,559-entry Upload outbox took 273 calls instead of about 7,250, and 0.49 s instead of 0.72 s in
headless Chrome.

Two database workers that start at once can race to delete the temporary directories that closed
workers left in OPFS, and the loser fails to open. A page that opens several replicas, or a replica
and a TanStack DB database, hits this on reloads, so the replica retries a failed open twice.

The writing tab tells the other tabs over a `BroadcastChannel` once a batch commits; `subscribe`
fires in every tab. `execute` waits for the tab's pending replication writes, so a read never sees
half of a batch.

The writing tab also shares its status over the channel, and a tab that opens asks for it. The
stream starts by naming the last entry that existed when it opened and marks when it has sent
everything up to it. The writer estimates progress from the versionstamps it applied in between, and
reports `caught-up` after the marker, once every entry before it has committed. A replica stays
`caught-up` from then on, and remembers it in `lofi_meta`, so later sessions open `caught-up` too:
its data is then a complete state of the backend, if an older one, and the stream replays what
changed since. A reconnect or a new writer catches up again without sending views back to waiting.

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
  connections, so reading tabs can stall while the writing tab catches up. The replica worker below
  avoids this: only its leader opens the database.
- **Catch-up speed.** A batch takes two worker calls, so the statements themselves and their parsing
  are now most of the cost. Statements are not prepared once and reused, because the worker takes
  only SQL text.
- **Other databases still race at startup.** The retry covers the replica's own open. A TanStack DB
  database that loses the race to a replica's worker still fails. wa-sqlite 2.x ignores the
  directory that is already gone, but `@tanstack/browser-db-sqlite-persistence` accepts only
  wa-sqlite `^1.4.1`, and 1.7.2 is the last 1.x release; a patch of 1.7.2 would cover both.
- **Projection changes.** A projection without `rebuild` keeps the rows its old code wrote until a
  registered schema's version changes. A rebuildable one that computes something new without a
  version bump does the same.
- **Rebuilds block.** A rebuild runs in one transaction, and decodes every stored row of its source
  tables, also those it ignores; reads wait meanwhile. Two stale projections over the same table
  read it twice. Projections cannot filter what is replayed yet.
- **Growth.** Databases left behind by a name change stay in OPFS and need cleanup.
- **Exact checkpoints.** The cursor is a versionstamp, as in `LofiClient`, and entries at or below
  the last one applied are skipped. That trusts the outbox to deliver ascending versionstamps:
  `@fragno-dev/tanstack-db-adapter` resumes from `{versionstamp, uowId}` and rejects a history it
  cannot verify; the replica does not.
- **Dangling references.** A reference to a row the replica does not hold, for example in a table
  you did not register, is stored as NULL and is not filled in if the row arrives later.
- **Errors that never clear.** A schema mismatch fails on every attempt, so each tab retries every
  `retryDelayMs` and reports the same error each time. The entries before the failing one in its
  batch are not applied either.
- **No snapshot across queries.** Each `execute` or `query` waits for pending writes, but the
  writing tab can apply an entry between two of a reader's queries, so a view built from several
  queries can mix states. The next change notification reads again. A read transaction would need
  its own connection, because replication writes share the tab's.
- **No indicator for a returning replica.** A replica that caught up in an earlier session shows its
  older state at once, and nothing says how far behind it is while the stream replays the gap.
- **Estimated progress.** `fraction` is the share of entries replayed, counted by the transaction
  versions in their versionstamps. Entries differ in size, so it does not track the time left.
- **Coarse refresh.** `subscribe` reports which tables a batch wrote, not which rows, so a reader
  runs a query again after any write to a table it reads. A writing tab on a lofi that does not
  report tables sends null, which refreshes everything.
- **JSON `null`.** A JSON column holding `null` is stored as SQL `NULL`, the same as a missing
  value.

## Replica worker and live views

`@fragno-dev/lofi/sqlite/worker` runs the replica in a dedicated worker, and pages read it through
live views: queries whose results the worker keeps up to date as outbox entries arrive. One tab's
worker opens the replica and maintains the views of every tab. SQL views are built in; other kinds
of views come from view engines, such as `@fragno-dev/lofi-zql`, which maintains ZQL views
incrementally.

The worker opens the replica in OPFS through wa-sqlite's OPFSCoopSyncVFS, with a synchronous
connection that view engines read, so it needs only `@journeyapps/wa-sqlite`. Each tab starts a
worker, with the same replica options as `openLofiSqliteReplica`:

```ts
// replica.worker.ts
import { serveLofiSqliteWorker } from "@fragno-dev/lofi/sqlite/worker";

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
  // View engines beyond SQL, such as `zqlViewEngine` from `@fragno-dev/lofi-zql/worker`.
  engines: [],
});
```

The page connects once a tab has opened the replica. A view's result is maintained while the view
has listeners:

```ts
import { connectLofiSqlite } from "@fragno-dev/lofi/sqlite";

const worker = new Worker(new URL("./replica.worker.ts", import.meta.url), { type: "module" });
// Rejects if the replica fails to open in the tab that tried.
const replica = await connectLofiSqlite({ port: worker, schemas: [{ schema: appSchema }] });

const { users } = appSchema.tables;
const $adults = replica.sql({
  sql: `SELECT "email", "joinedAt" FROM "users_app" WHERE "age" >= ?1 ORDER BY "email"`,
  params: [21],
  columns: { email: users.columns.email, joinedAt: users.columns.joinedAt },
});
$adults.subscribe((result) => {
  // { status: "loading" } | { status: "ready", data } | { status: "error", message }
});
```

`replica.getStatus()` and `replica.subscribeStatus()` report the replica's status, as
`LofiSqliteReplica`'s do, so a page can wait for the catch-up before showing views.

A SQL view's rows decode like `replica.query`'s (see Layout above). The worker runs the query again
after every batch that wrote a table it reads, and sends the rows only when they changed. The query
is one statement: SQL after it other than whitespace and comments is refused, as is a statement that
would write, since a write would bypass the replica.

### Which views refresh

The replica records the tables each batch writes, by SQL name: the rows of the outbox's mutations,
what projections write, and the tables a rebuild recreates. `replica.subscribe` passes them to its
listeners as `{ tables }`, and tabs that write tell the others; `tables` is null when a writing tab
runs a lofi that does not say. The leader adds up the tables of the batches since its last refresh
and passes them to every engine's `refresh(changed)`. SQLite's authorizer reports the tables a
statement reads while preparing it, as `statement.tables`, including the tables behind a view, so:

- a SQL view refreshes after a batch that wrote one of its statement's tables;
- a read view refreshes after a batch that wrote a table its last run read, since a read reads other
  tables only once one it read changed;
- an engine that cannot tell, such as `@fragno-dev/lofi-zql`'s, refreshes after every batch.

A view whose refresh fails reports the error to its page, which shows it instead of the data, and
the others refresh regardless. It runs again after a batch that wrote a table its last successful
run read, and reports its data again once it succeeds, even if the data is what it was before. An
engine whose `refresh` throws as a whole goes to `onError`; the other engines still refresh, and it
gets the tables again with the next batch's.

### View engines

A view engine maintains one kind of view. In the worker,
`engine.open({ connection, registrations })` starts it on the leader's synchronous connection, and
returns the engine's `materialize(id, query, listener, fail)`, `destroy(id)`, and
`refresh(changed)`. A view that fails to build throws from `materialize`; one that fails to refresh
reports it to `fail`, and calls `listener` again once it succeeds. The leader calls them only while
it holds a lock on the database, after every batch in the case of `refresh`, so they read
synchronously. Engines must not write the replica's tables: only the replica does. On the page,
`replica.view(kind, query)` asks the leader's engine of `kind` for a view; `query` must survive
`postMessage`.

`connection.prepare(sql)` prepares one statement and reports its `columnNames`, `isReadOnly`,
`tables`, and `parameterCount`. `connection.guarded(guard, run)` runs `run` with a `guard` that
decides each access the statements prepared meanwhile make, as SQLite's authorizer reports it, and
interrupts a statement that takes more than `guard.maxOperations` thousand of SQLite's operations or
produces a string or blob longer than `guard.maxLength`. wa-sqlite installs such hooks per module
rather than per connection, so the connection installs them only while it runs synchronously and
removes them before returning.

### Guarded SQL views

`guardedSqlViewEngine` maintains views of SQL that people or agents write, such as the queries of a
page, which the replica must survive. It gives queries relations of their own and keeps them from
everything else:

```ts
guardedSqlViewEngine({
  kind: "pages",
  // Temporary views on the leader's connection, which queries read by name.
  views: { people: `SELECT "id", "email" FROM "users_app"` },
  // Relations the app computes in JavaScript, which queries read as temporary tables.
  derived: {
    active_people: {
      columns: ["count"],
      compute: (reader) => [[countActive(reader)]],
    },
  },
  functions: ["count", "upper", "json_extract"],
  limits: { rows: 500, bytes: 4_000_000, operations: 25_000, length: 16_000_000 },
});
```

A view's query is `{ sql, params }`, one SELECT with its parameters bound as values, and its data is
`{ status: "ready", columns, rows, truncated }` or `{ status: "error", message }`: queries that
cannot run, and runs that fail, report why to the page that asked rather than to the worker.

- **Reads.** A query reads the `views` and `derived` relations, through which it reads the replica's
  tables, and table-valued JSON functions. It cannot read the replica's tables by name, write,
  attach, or run pragmas, and calls only `functions`; an error names what it may read instead.
- **Limits.** A view holds `limits.rows` rows and says when it dropped more. A run that takes more
  than `limits.operations` thousand operations, or rows holding more than `limits.bytes` bytes of
  text, in UTF-8, and blobs, fails. 25 million operations take about 200 ms in Node. A query given
  the wrong number of parameters fails for good.
- **Derived relations** run their `compute` with a reader of the replica, only while views exist,
  and again before the next refresh once a batch wrote a table their last run read. Rows that
  changed are written to the temporary table, and the views that read it refresh.
- **Checking on a server.** Open the engine on a connection to an empty in-memory database of the
  replica's tables, such as one `SqliteLofiAdapter.open` created, and `materialize` a query to learn
  whether it runs and which columns it selects before any page asks for it.

### Read views

A read view runs a function of several queries, for results one SQL statement cannot shape, such as
rows parsed and folded by the app's own code. `readViewEngine` runs named reads in the worker; each
gets a `LofiSqliteReader`, whose `query` decodes rows like `replica.query` but synchronously, and
returns data that survives `postMessage`. The leader runs a view's read again after every batch,
with the database locked, so all of its queries see one state, and sends the result only when it
changed. Reads must not write.

```ts
// reads.ts, imported by the worker
import type { LofiSqliteReader } from "@fragno-dev/lofi/sqlite";

export const appReads = {
  activity: (reader: LofiSqliteReader, { since }: { since: number }) => ({
    users: reader.query({ sql: `SELECT ...`, params: [since], columns: { ... } }),
    posts: reader.query({ sql: `SELECT ...`, params: [], columns: { ... } }),
  }),
};

// replica.worker.ts
serveLofiSqliteWorker({
  replica: { ... },
  engines: [readViewEngine({ kind: "app-reads", reads: appReads })],
});

// The page needs only the reads' types.
import { lofiSqliteReadViews } from "@fragno-dev/lofi/sqlite";
import type { appReads } from "./reads";

const appReadView = lofiSqliteReadViews<typeof appReads>("app-reads");
const $activity = appReadView(replica, "activity", { since: 0 });
```

### Leader tab

The workers of the tabs that replicate one backend with the same schemas elect a leader with a Web
Lock. The leader opens the replica, which makes it the writer too, and keeps the views of every tab.
The other tabs open no database: their workers send their page's requests to the leader over a
`BroadcastChannel`, and the leader answers each tab on a channel of its own, so a view's data goes
only to the tab that shows it.

- **Status.** The leader shares the replica's status with every tab, and a tab that opens asks for
  it. Pages connect once the first status arrives.
- **Closed tabs.** Each tab holds a Web Lock of its own while it lives. The leader waits for the
  locks of the tabs it serves, and drops a tab's views once it gets its lock.
- **A new leader.** When the leader closes, the next tab acquires the lock, opens the replica, which
  opens `caught-up` if it was, and tells the others, which send their views again. Each view shows
  its earlier data until its first new result.
- **A silent leader.** The leader sends a heartbeat every second from the moment it holds the lock.
  A tab waiting for the lock that hears nothing for 10 seconds steals it, and the deposed leader
  closes its replica once it runs again, sends its views to the new leader, and waits its turn.
- **A failed open.** A tab that fails to open the replica tells every tab, releases the lock, and
  stops competing; pages that had not connected yet reject. The next tab tries again.
- **Unknown kinds.** Tabs share a leader whatever engines they pass, since two leaders on one
  database would both open it. A view of a kind the leader's worker has no engine for fails.

### Risks and follow-ups

- **The worker's OPFS path has no automated test.** The scenario tests run the host in Node, with
  wa-sqlite's in-memory VFS standing in for OPFS and Node's Web Locks and `BroadcastChannel` for the
  browser's.
- **A frozen leader still stalls every tab.** A browser can freeze a background tab without closing
  it. Chrome documents that it does not freeze pages holding a Web Lock, but whether a lock held by
  a worker counts, and what other browsers do, is untested. A tab steals the lead from a frozen
  leader, but the frozen tab keeps the database's OPFS access handles, which wa-sqlite's VFS
  releases only when asked, so the new leader opens the replica once the frozen tab resumes or is
  discarded.
- **Late timers move the lead.** If a browser delays a hidden leader's timers past the timeout,
  another tab takes the lead and builds every view again. The lead then sits in a tab whose timers
  run.
- **Handover rebuilds.** A new leader opens the replica and then builds every tab's views from
  scratch, so views stop updating for a moment when the leader closes.
- **Tabs do not share views.** Two tabs with the same query get two views in the leader.
- **Tabs on other code.** Tabs whose schemas have the same versions share a leader even if they run
  different versions of lofi, whose messages could differ, or of a rebuildable projection, whose
  rows are then the leader's version.
- **A view that fails to build stays failed.** Only refreshes recover; a read that throws when its
  view is first built, for example because the replica has not caught up yet, fails until the page
  asks for the view again.
- **Views refresh by table.** A view refreshes after any batch that wrote a table it reads, even
  when the batch touched none of its rows, and a read's whole result is compared with the last one
  sent.
- **The guard has two gaps.** SQLite reports reads inside a CTE as made through the CTE, so a CTE
  named like a guarded view can read the replica's tables directly, and it reports `count(*)` of a
  table as a read of no column, so a query can count a table it may not read. Both need the
  replica's table names, which queries are not given; neither writes.
- **Derived relations hold all their rows.** A derived relation's rows are recomputed in full, and
  rewritten when any changed, so it suits relations of tens or hundreds of rows, such as agents.
- **Derived relations compute while any view is open.** Every stale derived relation is computed
  before a refresh once one guarded view exists, also when no open view reads it. Computing only
  those that an open view's statement reads would skip the rest.
- **Limits are per view.** Each run of a view gets its own operations budget, so a page of eleven
  queries that each approach it holds the leader, and every tab's views and synchronization, for
  eleven times as long after a batch. A budget per refresh would bound the whole.
- **TanStack's OPFS worker is still bundled.** `openLofiSqliteReplica` opens its database through
  `@tanstack/browser-db-sqlite-persistence`. Replica workers no longer reach it, but a bundler that
  follows `@fragno-dev/lofi/sqlite` still emits that package's worker as an unused asset; moving
  `openLofiSqliteReplica` to an entry of its own would leave it out.
- **Whole results cross to the page.** The worker posts a view's full data whenever it changes. For
  large views, posting the changes and applying them in the page would cost less.
- **No optimistic writes or submit.** As with the replica, views show server state only.

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
  `lofiSqliteTableName`, `quoteSqliteIdentifier` - the browser SQLite replica.
- `@fragno-dev/lofi/sqlite/testing`: `openLofiSqliteMemoryFiles` opens replicas in Node on
  wa-sqlite's in-memory VFS, `openLofiSqliteTab` opens a replica worker's host and its page's client
  over a `MessageChannel`, and `waitForLofiSqliteReplica` waits until a replica reaches a
  versionstamp - for scenario tests of apps that read a replica.
- `@fragno-dev/lofi/sqlite` also has `connectLofiSqlite`, which connects a page to its replica
  worker for live views.
- `@fragno-dev/lofi/sqlite/worker`: `serveLofiSqliteWorker`, `serveLofiSqlite`,
  `wrapWaSqliteDatabase`, `readViewEngine`, `guardedSqlViewEngine`, and the `LofiSqliteViewEngine`
  type - the replica worker, which maintains every tab's views.
- `LofiOverlayManager` - overlay manager that rebuilds queued optimistic commands.
- Outbox helpers: `decodeOutboxPayload`, `resolveOutboxRefs`, `outboxMutationsToUowOperations`.
- Types: `LofiClientOptions`, `LofiAdapter`, `LofiMutation`, `LofiQueryInterface`, and more.
