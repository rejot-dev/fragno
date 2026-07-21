# `@fragno-dev/tanstack-db`

Server-authoritative TanStack DB collections synchronized from Fragno through the Durable Streams
State Protocol.

Writes continue through Fragno routes or sync commands. Committed outbox mutations are projected to
State Protocol events, materialized into one atomic TanStack source collection, and exposed as typed
live-query collections.

## Setup

Enable the Fragno outbox and mount the authenticated adapter-wide state stream at:

```text
/_internal/outbox/durable/state
```

Define the public collection names used by the application:

```ts
import { createFragnoStateSchema, createFragnoStreamDB } from "@fragno-dev/tanstack-db";

import { commentsSchema } from "./comments-schema";
import { usersSchema } from "./users-schema";

const state = createFragnoStateSchema({
  comments: { schema: commentsSchema, table: "comment" },
  users: { schema: usersSchema, table: "user" },
});

const db = createFragnoStreamDB({
  state,
  streamOptions: {
    url: "/api/comments/_internal/outbox/durable/state",
  },
});

await db.collections.comments.preload();
console.log(db.collections.comments.toArray);
```

Explicit public names avoid collisions between tables from different schemas and form part of the
persisted cache identity.

Use the collections with TanStack DB or framework bindings such as `@tanstack/react-db`:

```tsx
import { eq, useLiveQuery } from "@tanstack/react-db";

const { data: comments = [] } = useLiveQuery((query) =>
  query
    .from({ comments: db.collections.comments })
    .where(({ comments }) => eq(comments.authorId, userId)),
);
```

The first collection subscription activates the shared stream automatically. `db.preload()` can be
used when an application wants explicit eager activation.

## Upstream alignment

The API follows `@durable-streams/state/db` where the semantics overlap:

- `state` defines typed State Protocol collections;
- `streamOptions` constructs the `DurableStream`; network consumption remains inactive until the
  database is activated;
- `stream` can inject an existing `DurableStream`;
- collections are exposed through `db.collections`;
- `db.preload()` waits for initial authoritative catch-up;
- `db.offset` reports the latest accepted stream offset;
- `db.utils.awaitTxId()` waits for a committed State Protocol transaction ID;
- `db.close()` ends transport and collection work.

Fragno adds stronger persisted, coordinated, and readiness semantics. Its collections are
server-authoritative and are not an alternative write path around Fragno routes.

## Synchronization control

Tests and orchestration code can await finite synchronization without polling:

```ts
await db.syncOnce();

const previousOffset = db.offset;
await createComment();
await db.drain({ afterOffset: previousOffset });
```

- `syncOnce()` performs one finite catch-up.
- `drain()` waits for already requested synchronization without starting a consumer.
- `drain({ afterOffset })` waits for an active consumer to accept a later ready checkpoint.
- `subscribeStatus()` observes `idle`, `loading`, `ready`, `error`, and `closed` transitions.
- `utils.awaitTxId(txid, timeout?)` resolves after the targeted event's complete batch and
  checkpoint have been accepted, including the exact persistence write when persistence is
  configured. Its default timeout is five seconds.

Await `close()` before disposing dependencies:

```ts
await db.close();
```

## Existing DurableStream

Pass either `streamOptions` or `stream`, never both:

```ts
import { DurableStream } from "@durable-streams/client";

const stream = new DurableStream({
  url: "/api/comments/_internal/outbox/durable/state",
  contentType: "application/json",
  headers: { Authorization: `Bearer ${token}` },
});

const db = createFragnoStreamDB({ state, stream });
```

## Consumer mode and callbacks

The default consumer mode is `"long-poll"`. Set `live: false` when activation should perform one
finite catch-up instead of leaving a live consumer running:

```ts
const db = createFragnoStreamDB({
  state,
  streamOptions: { url: "/api/comments/_internal/outbox/durable/state" },
  live: false,
});
```

Optional callbacks expose the State Protocol lifecycle:

- `onBeforeBatch(batch)` runs before any event in the batch is planned or validated.
- `onEvent(event)` runs after that event's envelope is validated, including well-formed control and
  unknown-type events, but before the TanStack transaction opens.
- `onBatch(batch)` runs after rows and checkpoint commit, persistence acknowledgment, any resulting
  readiness transition, and transaction-ID observation.
- `onError(error)` runs on the first terminal stream error.

Exceptions from callbacks become stream errors. In particular, `onBatch` runs after the batch is
already committed, so it should be observational rather than used for validation.

## Browser persistence

TanStack DB's official browser persistence uses SQLite WASM backed by OPFS:

```bash
pnpm add @tanstack/browser-db-sqlite-persistence @journeyapps/wa-sqlite
```

```ts
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
} from "@tanstack/browser-db-sqlite-persistence";

const database = await openBrowserWASQLiteOPFSDatabase({
  databaseName: "app.sqlite",
});
const coordinator = new BrowserCollectionCoordinator({ dbName: "app" });
const persistence = createBrowserWASQLitePersistence({ database, coordinator });

const db = createFragnoStreamDB({
  state,
  streamOptions: {
    url: "/api/comments/_internal/outbox/durable/state",
  },
  persistence: {
    provider: persistence,
    scope: `account:${accountId}`,
    version: 1,
  },
});
```

The scope is required because authenticated requests to the same URL can expose different state. It
must identify the current user, tenant, or other authorization boundary. Increment `version` when a
materialized row shape changes.

The persisted identity also includes the stream URL and a canonical fingerprint of public collection
names, State Protocol event types, schema names, namespaces, and table names. Collection definition
order does not change the identity.

All collections are projected from one persisted source collection. Rows from different tables and
their checkpoint commit in one TanStack transaction. A stream batch is not accepted until the exact
checkpoint generation has committed to the persistence adapter.

With `BrowserCollectionCoordinator`, only the elected leader opens the Durable Streams connection.
Followers hydrate from SQLite, observe committed source transactions, and receive terminal leader
errors instead of waiting indefinitely.

Await `db.close()` before disposing the coordinator and database. See
`example-apps/react-spa-tanstack-db` for a complete integration.

## Namespaces

A state collection defaults to the logical schema name as its physical database namespace. Specify a
custom namespace or `null` explicitly. Each physical schema/namespace/table event type may appear
only once in a state definition; defining aliases for the same physical table is rejected.

```ts
const state = createFragnoStateSchema({
  tenantComments: {
    schema: commentsSchema,
    table: "comment",
    namespace: "tenant-comments",
  },
  systemSettings: {
    schema: systemSchema,
    table: "setting",
    namespace: null,
  },
});
```

## Lifecycle

- Construction creates collections but performs no network request.
- A public collection subscription, collection preload, `db.preload()`, or `syncOnce()` activates
  the shared source.
- Persisted rows hydrate before the stream resumes from the persisted checkpoint.
- Collections remain loading until the stream reaches an up-to-date response and its exact
  checkpoint persistence write completes.
- Once activated, the application-scoped runtime remains active until `close()`.
- Initial and post-ready terminal errors reject later readiness calls on the public Fragno
  collections.
- Downstream TanStack live queries transition to `error` when a dependency fails, but TanStack does
  not currently expose a public asynchronous hook that lets Fragno reject every independently
  created downstream preload promise.
- `close()` aborts transport work, rejects transaction waiters, waits for persistence, and cleans up
  all collections.

## Materialization semantics

Fragno emits standard State Protocol change events. Event values use a versioned Fragno SuperJSON
codec so dates, bigints, binary values, and nested JSON retain their runtime types.

- Creates carry complete visible non-ID values and become inserts or replay-safe updates.
- Historical create events replayed after additive schema changes fill current static defaults and
  nullable columns before complete-row validation; runtime-generated defaults must still be present
  in the event.
- The event key is authoritative and becomes the table's external ID column.
- Updates currently carry an explicit Fragno patch value because all database adapters cannot yet
  produce complete update post-images without an extra round-trip.
- Patches merge into the current row; a patch for a missing row is ignored.
- Deletes are idempotent.
- Reference placeholders are resolved on the server before State Protocol events are exposed.
- Complete rows are validated with the Standard Schema validator on the Fragno table.
- Every targeted event in a response is decoded and validated before a TanStack transaction opens.
- One response batch and its monotonic checkpoint commit atomically.
- Every event envelope is validated; well-formed unknown event types are ignored.
- `reset` control events clear the materialized source before later events in the same batch apply.
  Snapshot start/end controls are accepted as ordering markers and otherwise require no sink action.

The patch value is a documented Fragno extension to upstream replacement semantics. It can be
removed once Fragno mutation adapters provide complete post-images in the existing mutation
round-trip.

## Current limitations

- Without persistence, state replays from the beginning after reload.
- Browser persistence requires OPFS in a supported secure browser context.
- There are no optimistic collection writes that bypass Fragno routes.
- Fragno currently supports Durable Streams long-polling, not SSE.

The state stream contains application data derived from internal mutation history. Protect it with
the application's normal authentication and authorization layer.
