# @fragno-dev/tanstack-db-adapter

Ingest one Fragno database outbox into a durable, database-level set of eager TanStack DB
collections.

The adapter is intentionally one-way. It synchronizes server mutations into TanStack DB; client
mutations, optimistic overlays, command submission, and on-demand subsets are out of scope.

## Collection setup

Create one coordinator for each physical Fragno outbox. Supply every schema represented by that
outbox, register the tables used by the application, and preload once after registration closes:

```ts
import { createFragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter";

const coordinator = await createFragnoOutboxCoordinator({
  baseUrl: "/api/app",
  fetch: globalThis.fetch,
  schemas: [appSchema, workflowsSchema] as const,
});

const users = coordinator.collection(appSchema, "users");
const posts = coordinator.collection(appSchema, "posts");
const workflowInstances = coordinator.collection(workflowsSchema, "workflow_instance");

await coordinator.preload();
```

Collections can only be registered while the coordinator is `"idle"`. `preload()` performs finite
catch-up, waits for accepted persistence writes to become durable, marks every collection ready, and
opens one shared live stream from the exact database checkpoint.

Clean up the database-level resource when it is no longer used:

```ts
await coordinator.cleanup();
```

## Authenticated and scoped Fetch

Pass a Fetch implementation that forwards authentication or routes requests to the correct scoped
backend:

```ts
const coordinator = await createFragnoOutboxCoordinator({
  baseUrl: "/api/app-scoped/org/acme",
  fetch: (input, init) =>
    fetch(input, {
      ...init,
      headers: {
        ...init?.headers,
        authorization: `Bearer ${token}`,
      },
    }),
  schemas: [appSchema] as const,
});
```

The coordinator derives these routes from `baseUrl`:

- `GET /_internal`
- `GET /_internal/outbox`
- `GET /_internal/outbox/stream`

Catch-up requests use aligned 500-entry pages. The coordinator decodes each entry once, routes its
operations to registered physical targets, and opens the stream from the resulting exact checkpoint.
Unexpected stream closure transitions through `"retrying"` and `"replaying"`, performs finite
replay, and reconnects with exponential backoff.

To retrieve source metadata without opening browser persistence, use the same typed description
request:

```ts
import { fetchFragnoOutboxDescription } from "@fragno-dev/tanstack-db-adapter";

const description = await fetchFragnoOutboxDescription({
  baseUrl: "/api/app",
  fetch: authenticatedFetch,
  signal: request.signal,
});

console.log(description.adapterIdentity, description.currentVersionstamp);
```

## Coordinator state

The current lifecycle state is available directly and through the reactive internal collection:

```ts
coordinator.state;
coordinator.internal.collection;
coordinator.internal.getCheckpoint();
```

Lifecycle states are:

```ts
"opening" |
  "idle" |
  "registering" |
  "catching-up" |
  "caught-up" |
  "live" |
  "retrying" |
  "replaying" |
  "failed" |
  "disposed";
```

`coordinator.internal.collection` contains one `"coordinator"` row with the state, exact checkpoint,
and serialized error. It can be consumed by ordinary TanStack live queries.

## Checkpoints and persistence

One physical outbox maps to one local persistence database and one shared exact checkpoint:

```ts
type FragnoOutboxCheckpoint = {
  versionstamp: string;
  uowId: string;
};
```

During finite catch-up, each affected collection applies one page in one TanStack transaction. Row
changes and that collection's applied-entry checkpoint commit together. The shared database
checkpoint advances only after every affected collection accepts the page, and ordered persistence
prevents it from overtaking an earlier failed table write.

Separate TanStack collection commits remain independently observable. The coordinator provides
ordered, replay-safe convergence, not atomic cross-collection UI visibility.

Browser persistence is opened automatically with TanStack's `BrowserCollectionCoordinator`, so one
tab owns the SQLite writer. The OPFS database identity includes:

- normalized `baseUrl`;
- backend adapter identity;
- `FRAGNO_OUTBOX_LOCAL_SCHEMA_VERSION`.

Changing the backend adapter identity or local schema version opens a fresh local database and
replays the outbox. Increase `FRAGNO_OUTBOX_LOCAL_SCHEMA_VERSION` whenever a persisted materialized
row format changes.

## Row update mode

Fragno update entries contain patches, so collections default to partial-row handling:

```ts
const users = coordinator.collection(appSchema, "users", {
  rowUpdateMode: "partial",
});
```

Append-only tables that never receive Fragno update operations can use full-row handling:

```ts
const emissions = coordinator.collection(workflowsSchema, "workflow_step_emission", {
  rowUpdateMode: "full",
  skipMissingTruncateDeletes: true,
});
```

Do not use `"full"` for tables that receive updates. Their outbox values are patches rather than
complete rows.

`skipMissingTruncateDeletes` scans persisted rows before finite catch-up and skips truncate-derived
deletes for keys that are already absent. Ordinary deletes and live truncate delivery remain
unchanged.

## Catch-up progress

Use `onCatchUpProgress` for a loading indicator:

```ts
const coordinator = await createFragnoOutboxCoordinator({
  baseUrl: "/api/app",
  fetch: globalThis.fetch,
  schemas: [appSchema] as const,
  onCatchUpProgress(progress) {
    console.log(progress.completedPages, progress.totalPages, progress.percent);
  },
});
```

The percentage assumes contiguous database versions between the persisted checkpoint and the
server's current versionstamp.
