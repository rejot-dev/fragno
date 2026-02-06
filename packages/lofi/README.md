# @fragno-dev/lofi

Local-first client for Fragno. Lofi polls the Fragno DB outbox, applies mutations into a local
IndexedDB store, and exposes a read-only query engine that mirrors the server query builder.

## Who is this for?

- App authors integrating Fragno fragments who want fast local reads and offline-friendly access.
- Projects using `@fragno-dev/db` with the outbox endpoint enabled.

## What it does

- Polls `GET /outbox` and persists a cursor so sync resumes after reloads.
- Applies create/update/delete mutations to IndexedDB with idempotency.
- Provides a read-only query engine (`find`, `findFirst`, `findWithCursor`).

Out of scope (for now): client-side writes, conflict resolution, and live reactive queries.

## Install

```bash
pnpm add @fragno-dev/lofi @fragno-dev/db
# or
npm install @fragno-dev/lofi @fragno-dev/db
```

## Quick start

### 1) Enable the outbox on the server

The outbox route is exposed by `@fragno-dev/db` when the database adapter has outbox enabled. Your
app must mount the internal `/outbox` route and keep it stable.

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
  outboxUrl: "https://example.com/outbox",
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

## Notes

- `endpointName` must match between `LofiClient` and `IndexedDbAdapter`.
- The adapter stores data in one IndexedDB database (default name: `fragno_lofi_<endpointName>`).
- If the registered schema changes, Lofi clears local rows for that endpoint and re-syncs.
- `outboxUrl` can include query parameters; Lofi preserves them when adding cursor/limit params.

## Exports

- `LofiClient` - polls outbox and applies entries.
- `IndexedDbAdapter` - IndexedDB-backed `LofiAdapter` and query engine.
- Outbox helpers: `decodeOutboxPayload`, `resolveOutboxRefs`, `outboxMutationsToUowOperations`.
- Types: `LofiClientOptions`, `LofiAdapter`, `LofiMutation`, `LofiQueryInterface`, and more.
