# @fragno-dev/tanstack-db-adapter

Ingest Fragno's durable database outbox into eager TanStack DB collections.

The current adapter is intentionally one-way: it polls server mutations into TanStack DB. Client
mutations, optimistic overlays, command submission, streaming, and on-demand subsets are out of
scope.

## Collection setup

Create one coordinator for every Fragno outbox endpoint and share it across all collections that
materialize that outbox:

```ts
import { createCollection } from "@tanstack/react-db";
import { fragnoCollectionOptions } from "@fragno-dev/tanstack-db-adapter";
import { createFragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter/coordinator";

const coordinator = createFragnoOutboxCoordinator({
  internalUrl: "/api/app/_internal",
});

const users = createCollection(
  fragnoCollectionOptions({
    id: "app.users",
    coordinator,
    target: {
      schema: appSchema,
      table: "users",
    },
  }),
);

const posts = createCollection(
  fragnoCollectionOptions({
    id: "app.posts",
    coordinator,
    target: {
      schema: appSchema,
      table: "posts",
    },
  }),
);
```

The adapter uses eager synchronization and partial row updates. A collection is marked ready after
the coordinator drains every entry visible to its catch-up request.

Dispose the coordinator when the application no longer uses the endpoint:

```ts
coordinator.dispose();
```

## Coordinator transport and polling

The default transport requests `GET /_internal/outbox` with `afterVersionstamp` and `limit` query
parameters. Configure page size, polling, error handling, or an authenticated Fetch implementation
on the coordinator:

```ts
import { createFragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter/coordinator";
import { createFetchFragnoOutboxTransport } from "@fragno-dev/tanstack-db-adapter/transport";

const coordinator = createFragnoOutboxCoordinator({
  internalUrl,
  transport: createFetchFragnoOutboxTransport({
    internalUrl,
    fetch: authenticatedFetch,
  }),
  pageSize: 100,
  pollIntervalMs: 1_000,
  onError(error) {
    console.error(error);
  },
});
```

The coordinator owns no row state. It registers collection consumers, refreshes the adapter identity
before each synchronization, fetches from the oldest registered collection checkpoint, serializes
synchronization attempts, and dispatches every outbox entry to every registered collection before
advancing to the next entry. Failed background polls retry with exponential backoff and jitter,
capped at one minute or the configured polling interval when it is longer; a successful
synchronization resets the retry interval.

Calling `collection.utils.syncOnce()` synchronizes every collection registered with the same
coordinator. `getSyncStatus()`, `getLastError()`, and `initialSync()` expose synchronization state;
`initialSync()` rejects when the collection's first synchronization attempt fails.

## Synchronization transaction and checkpoints

Each collection applies an outbox entry as one TanStack sync transaction:

1. Decode and project all mutations for the target namespace and table.
2. Call `begin()`.
3. Write matching inserts, partial updates, and deletes.
4. Store the entry checkpoint in collection metadata.
5. Call `commit()`.

The metadata key is:

```ts
fragno.outbox.checkpoint.v1;
```

Its value is:

```ts
type FragnoOutboxCheckpoint = {
  versionstamp: string;
  uowId: string;
};
```

The checkpoint is committed even when an entry contains no mutations for the target table. The
versionstamp represents the ordered applied prefix, while the UOW ID verifies exact replays.

If one collection commits an entry and another collection fails, the coordinator retries from the
oldest collection checkpoint. Collections that already committed the entry skip it, while lagging
collections apply it. The coordinator never intentionally starts the next outbox entry before every
registered collection finishes the current one.

Separate TanStack collection commits remain independently observable and independently persisted.
The coordinator provides ordered, crash-recoverable convergence, not atomic cross-collection
visibility or persistence.

Create and update values include the table's external-ID column because TanStack persistence derives
the row key from the written value. Updates otherwise contain only Fragno's changed `set` fields and
the sync configuration uses `rowUpdateMode: "partial"`.

## Persistence

Persistence remains a TanStack concern. Create the platform persistence adapter, then bind it once
to a Fragno collection factory:

```ts
import { createPersistedFragnoCollectionFactory } from "@fragno-dev/tanstack-db-adapter/persistence";

const createPersistedCollection = createPersistedFragnoCollectionFactory({
  persistence,
  schemaVersion: 1,
});

const users = createPersistedCollection({
  id: "app.users",
  coordinator,
  target: { schema: appSchema, table: "users" },
});
```

The factory creates the Fragno collection options, wraps them with TanStack persistence, and
preserves the inferred row and synchronization utility types. TanStack persists a collection's row
changes and checkpoint from the same sync transaction. Recreating the collection hydrates both
before it registers with the coordinator. Bump `schemaVersion` when the materialized row shape
changes.

Browser consumers must use TanStack's browser collection coordinator so only one tab owns the SQLite
writer.

## Test scenario

`@fragno-dev/tanstack-db-adapter/scenario` provides an end-to-end harness with:

- a real in-memory SQLite Fragno backend and durable outbox from `@fragno-dev/test`;
- ordinary Fetch requests routed through the instantiated Fragno fragment;
- a separate `better-sqlite3` database for TanStack persistence;
- server, ingest, reload, and assertion steps;
- direct inspection of persisted rows and collection metadata.

The end-to-end suite covers inserts, partial updates, deletes, pagination, explicit synchronization,
concurrent synchronization attempts, table and namespace filtering, checkpoints, row metadata,
persistence reloads, generated IDs, reference resolution, special values, and larger mutation
batches.
