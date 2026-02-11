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
  adapter,
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
const optimisticQuery = overlay.createQueryEngine(appSchema);
const optimisticUsers = await optimisticQuery.find("users");
```

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
fragno-lofi --endpoint http://localhost:3000/api/fragno-db-comment --timeout 5
```

Notes:

- `--endpoint` can be the fragment base URL or the full `/_internal/outbox` URL.
- Use `--endpoint-name` to override the local endpoint key used for IndexedDB storage.

## Exports

- `LofiClient` - polls outbox and applies entries.
- `IndexedDbAdapter` - IndexedDB-backed `LofiAdapter` and query engine.
- Outbox helpers: `decodeOutboxPayload`, `resolveOutboxRefs`, `outboxMutationsToUowOperations`.
- Types: `LofiClientOptions`, `LofiAdapter`, `LofiMutation`, `LofiQueryInterface`, and more.
