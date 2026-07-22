# @fragno-dev/tanstack-db-adapter

Ingest Fragno's durable database outbox into eager TanStack DB collections.

The current adapter is intentionally one-way: it synchronizes server mutations into TanStack DB
through polling or a persistent outbox stream. Client mutations, optimistic overlays, command
submission, and on-demand subsets are out of scope.

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

## Coordinator transports

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

Use the streaming transport to bootstrap new collections through the paginated endpoint and then
keep one NDJSON connection open for catch-up and live entries:

```ts
import { createFragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter/coordinator";
import { createFetchFragnoOutboxStreamingTransport } from "@fragno-dev/tanstack-db-adapter/streaming-transport";

const transport = createFetchFragnoOutboxStreamingTransport({ internalUrl });
const coordinator = createFragnoOutboxCoordinator({
  internalUrl,
  transport,
});
```

The coordinator owns no row state. It registers collection consumers, resolves the adapter identity
once for its lifetime, serializes synchronization attempts, and dispatches every outbox entry to
every registered collection before advancing to the next entry. A new or invalidated collection uses
the paginated endpoint for its initial bootstrap. Once collection metadata records a completed
bootstrap, reconnects open the stream directly from the oldest checkpoint and let the stream replay
entries committed while disconnected. Failed background polls and stream connections retry with
exponential backoff and jitter, capped at one minute or the configured polling interval when it is
longer.

`dispose()` permanently stops the coordinator and clears its consumers. When TanStack cleans up an
inactive collection, its consumer unregisters automatically and the coordinator closes an unused
stream.

A server loader can supply the serializable bootstrap data and avoid the internal describe request
in the browser:

```ts
const coordinator = createFragnoOutboxCoordinator({
  internalUrl,
  bootstrap: {
    adapterIdentity: loaderData.adapterIdentity,
  },
  transport: createFetchFragnoOutboxStreamingTransport({ internalUrl }),
});
```

Without supplied bootstrap data, concurrent identity requests are deduplicated and a successful
response is cached. Fetch transports share that cache by internal URL for the lifetime of a browser
page, while server runtimes do not use a process-global cache. Reload the page or supply new
bootstrap data to discover a changed adapter identity.

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

The collection metadata keys are:

```ts
fragno.outbox.checkpoint.v1;
fragno.outbox.initialized.v1;
```

The initialized flag is written only after the first finite bootstrap succeeds. It allows a retained
or persisted collection to expose its existing snapshot immediately while the stream catches up in
the background.

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

Fragno collections should normally be persisted. Create the platform persistence adapter, then bind
it once to a Fragno collection factory:

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
changes, checkpoint, source identity, and initialization state. Recreating an initialized collection
hydrates its local snapshot before registering with the coordinator, exposes those rows without
waiting for the network, and reconnects from its checkpoint in the background. Bump `schemaVersion`
when the materialized row shape changes.

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
