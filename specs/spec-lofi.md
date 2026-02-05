# Fragno Lofi (Local-First Client) - Spec

## 0. Open Questions

None.

## 1. Overview

This document specifies `@fragno-dev/lofi`, a local-first client package for Fragno that **polls the
Fragno DB outbox** and applies mutations to a **local IndexedDB store**. The package is
framework-agnostic, runs in the browser at runtime, and uses **Node + fake-indexeddb** for Vitest
tests.

Lofi is keyed by **schema name** (author-defined, required, non-empty) and **endpoint name**
(user-defined). Outbox payloads include a schema name only.

Initial scope:

- Outbox polling and cursor management.
- Outbox payload decoding and transformation utilities.
- IndexedDB adapter for applying create/update/delete mutations.
- Test harness for sync behavior using fake-indexeddb.

Out of scope for this iteration:

- Client-side writes, conflict detection, or optimistic layering.
- Stacked data store (in-memory overlay + IndexedDB) and live query system.

## 2. References

- Outbox spec: `specs/spec-outbox.md`
- Outbox payload types: `packages/fragno-db/src/outbox/outbox.ts`
- Outbox payload builder (refMap + versionstamp rules):
  `packages/fragno-db/src/outbox/outbox-builder.ts`
- Internal outbox route: `packages/fragno-db/src/fragments/internal-fragment.routes.ts`
- Internal outbox service: `packages/fragno-db/src/fragments/internal-fragment.ts`
- Outbox route enablement: `packages/fragno-db/src/with-database.ts`
- Unit of Work operations: `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts`
- Condition builder: `packages/fragno-db/src/query/condition-builder.ts`
- Cursor utilities: `packages/fragno-db/src/query/cursor.ts`
- In-memory condition evaluation: `packages/fragno-db/src/adapters/in-memory/condition-evaluator.ts`
- In-memory normalization: `packages/fragno-db/src/adapters/in-memory/store.ts`
- Migration generation: `packages/fragno-db/src/migration-engine/auto-from-schema.ts`
- Wilcofirst architecture reference: `specs/references/wilcofirst.md`

## 3. Terminology

- **Outbox entry**: A single outbox row returned by `/outbox` (see `OutboxEntry`).
- **Schema name**: Required name on a Fragno schema (`schema.name`). Must be non-empty.
- **Endpoint name**: Stable identifier for the outbox URL (user-provided, string).
- **Outbox cursor**: The last processed outbox entry `versionstamp` (hex string).
- **Mutation**: A single create/update/delete operation inside an outbox payload.
- **Local store**: IndexedDB-backed storage for fragment tables and metadata.
- **Adapter**: The local storage implementation (IndexedDB now; in-memory overlay later).

## 4. Goals / Non-goals

### 4.1 Goals

1. Provide a local-first client that can **poll the outbox endpoint** and **apply mutations** in
   order.
2. Ensure outbox payloads are **decoded and refMap-resolved** consistently with `@fragno-dev/db`.
3. Persist a **local cursor** so sync can resume after reloads.
4. Supply an **IndexedDB adapter** that is deterministic and testable via fake-indexeddb.
5. Provide a **read-only local query engine** for IndexedDB-backed data.
6. Keep the API **framework-agnostic** and safe for browser usage.
7. Use **schema name + endpoint name** to uniquely scope local data.

### 4.2 Non-goals (initial)

- Client-originated writes or conflict detection.
- Stacked data store (optimistic overlay + base store).
- Cross-tab sync or broadcast channels.
- Live query reactivity (will be future work).
- Server-side components beyond the existing `/outbox` route.

## 5. Package Layout and Build

### 5.1 Package

- New package: `@fragno-dev/lofi`
- Location: `packages/lofi/` with `src/mod.ts`
- Tooling: TSdown + Vitest (same as other packages)

### 5.2 Exports (initial)

The main entrypoint should export:

- `createLofiClient` / `LofiClient` (poller + apply loop)
- `IndexedDbAdapter`
- Outbox utilities:
  - `decodeOutboxPayload`
  - `resolveOutboxRefs`
  - `outboxMutationsToUowOperations`
- Types for adapter + client options
- Query engine types

If test helpers are exported, add a separate entrypoint (e.g. `@fragno-dev/lofi/testing`) to avoid
shipping test-only dependencies in runtime bundles.

### 5.3 Client-safe Fragno DB exports

To keep browser bundles small and safe, add a new `@fragno-dev/db/client` export that re-exports
only browser-safe utilities:

- `createBuilder` / `buildCondition` + types from `query/condition-builder.ts`
- `Cursor`, `decodeCursor`, `createCursorFromRecord` from `query/cursor.ts`
- `generateMigrationFromSchema` (schema → index operations)

Do **not** export driver configs, naming strategies, SQL serializers, or `serializeCursorValues`.
This entrypoint must remain browser-safe (no Node-only imports such as `node:crypto` and no `Buffer`
usage).

## 6. Public API Surface

### 6.1 Client Options

```ts
export type LofiClientOptions = {
  outboxUrl: string; // full URL to GET /outbox
  endpointName: string; // stable identifier for this outbox endpoint (maps to outboxUrl)
  adapter: LofiAdapter;
  fetch?: typeof fetch;
  pollIntervalMs?: number; // default 1000
  limit?: number; // default 500
  cursorKey?: string; // optional explicit key for cursor persistence
  onError?: (error: unknown) => void;
  signal?: AbortSignal; // default signal for polling
};
```

`endpointName` must be **stable** across page reloads and should be unique per outbox source. It
must match the `IndexedDbAdapterOptions.endpointName`.

### 6.2 Client Interface

```ts
export type LofiSyncResult = {
  appliedEntries: number; // counts entries actually applied (not inbox skips)
  lastVersionstamp?: string; // undefined if no entries were read
};

export class LofiClient {
  constructor(options: LofiClientOptions);
  start(options?: { signal?: AbortSignal }): void;
  stop(): void;
  syncOnce(options?: { signal?: AbortSignal }): Promise<LofiSyncResult>;
}
```

### 6.3 Adapter Interface

```ts
export type LofiSchemaRegistration = { schema: AnySchema };

export type LofiAdapter = {
  /**
   * Apply an outbox entry with inbox idempotency.
   * Returns { applied: false } if the inbox already contains the entry.
   * MUST be atomic: inbox record + row mutations are all-or-nothing.
   * If this throws, no inbox entry or row changes may have been persisted.
   */
  applyOutboxEntry(options: {
    sourceKey: string;
    versionstamp: string;
    mutations: LofiMutation[];
  }): Promise<{ applied: boolean }>;
  /**
   * Internal helper used by applyOutboxEntry. Not required for external use.
   */
  applyMutations?(mutations: LofiMutation[]): Promise<void>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
};

export type IndexedDbAdapterOptions = {
  dbName?: string;
  endpointName: string;
  schemas: LofiSchemaRegistration[];
};
```

### 6.4 Local query engine (read-only)

```ts
export type LofiQueryInterface<TSchema extends AnySchema> = {
  find: SimpleQueryInterface<TSchema>["find"];
  findFirst: SimpleQueryInterface<TSchema>["findFirst"];
  findWithCursor: SimpleQueryInterface<TSchema>["findWithCursor"];
};

export type LofiQueryEngineOptions = {
  schemaName?: string; // defaults to schema.name
};

export interface LofiQueryableAdapter {
  createQueryEngine<const T extends AnySchema>(
    schema: T,
    options?: LofiQueryEngineOptions,
  ): LofiQueryInterface<T>;
}
```

`IndexedDbAdapter` implements both `LofiAdapter` and `LofiQueryableAdapter`.

Return types must match `SimpleQueryInterface` outputs. `FragnoId` and `FragnoReference` values are
constructed using **local** internal IDs maintained by the adapter (see §9.1 and §10).

### 6.5 Mutation Types

```ts
export type LofiMutation =
  | {
      op: "create";
      schema: string;
      table: string;
      externalId: string;
      values: Record<string, unknown>;
      versionstamp: string;
    }
  | {
      op: "update";
      schema: string;
      table: string;
      externalId: string;
      set: Record<string, unknown>;
      versionstamp: string;
    }
  | {
      op: "delete";
      schema: string;
      table: string;
      externalId: string;
      versionstamp: string;
    };
```

## 7. Outbox Polling Flow

1. Determine the cursor:
   - If `cursorKey` is set, use it (caller is responsible for uniqueness and endpoint scoping).
   - Otherwise use a derived key: `${endpointName}::outbox`.
   - Read cursor from adapter meta storage (`getMeta`).
2. Derive the **inbox source key** from the cursor key (same value).
3. Fetch outbox entries via `GET outboxUrl?afterVersionstamp=...&limit=...` while preserving any
   existing query parameters on `outboxUrl`.
   - If no cursor exists, **omit** `afterVersionstamp`.
4. For each entry in order:
   - Decode payload with `superjson.deserialize`.
   - Resolve `refMap` placeholders.
   - Convert to `LofiMutation[]` (use `mutation.schema` as the schema name).
   - Call `adapter.applyOutboxEntry({ sourceKey, versionstamp, mutations })`, where `versionstamp`
     is the **outbox entry** versionstamp (not per-mutation versionstamps).
   - If `applied === false`, still advance the cursor to this `versionstamp`.
   - Update cursor to the entry `versionstamp` **after** successful apply or skip.
5. If a page returns `limit` entries, immediately fetch the next page to drain backlog.
   - Implement page draining via an internal async iterator (e.g. `async function*` yielding pages)
     so `syncOnce()` can reuse the same logic.
6. `start()` loops `syncOnce()` on an interval; `stop()` cancels future polls.

Polling loop semantics:

- `start()` is idempotent; it does nothing if a loop is already running and triggers an immediate
  `syncOnce()` before scheduling the interval.
- Only **one** `syncOnce()` may run at a time. If a tick fires while a sync is in flight, that tick
  is skipped. If `syncOnce()` is called while a sync is in flight, it returns the in-flight promise.
- `stop()` prevents future ticks and cancels the in-flight request (if any), then returns.

Abort semantics:

- If `signal` is aborted before or during fetch, abort the request and return without error.
- If `signal` aborts during apply, stop after the current entry (do not advance cursor for failed
  entry).

Schema handling:

- The client applies **all** outbox mutations; no schema allowlist is part of the initial API.
- The schema name and endpoint name are incorporated into the `lofi_rows` key.

Failure behavior:

- If apply fails, do **not** advance the cursor.
- `syncOnce()` throws on non-2xx responses, network errors, or payload decode failures.
- Errors invoke `onError` and stop the loop until next explicit `start()`.

## 8. Outbox Decoding and Transform Utilities

### 8.1 Payload decoding

- `OutboxEntry.payload` uses `superjson` `{ json, meta }`.
- `decodeOutboxPayload(entry.payload)` returns `OutboxPayload`.
  - `OutboxMutation.schema` is the **schema name** (required, non-empty).
  - Missing or empty `schema` is a hard error.
  - Extra fields are ignored.

### 8.2 RefMap resolution

`resolveOutboxRefs(mutation, refMap)` replaces values shaped like `{ __fragno_ref: string }` with
`refMap[key]` (external IDs). This applies to both create values and update sets. Resolution is
**shallow** (top-level values only). Missing keys **throw**.

### 8.3 UOW conversion

`outboxMutationsToUowOperations(mutations, schemaMap)` converts outbox mutations into
`MutationOperation<AnySchema>[]` using `schemaMap` keyed by **schema name**:

- `create` -> `MutationOperation` with `generatedExternalId`.
- `update/delete` -> use `mutation.externalId` as the string ID and `checkVersion: false` (client
  ignores outbox version checks).
- If `schemaMap` lacks a schema name from the payload, throw.

These utilities are used by the IndexedDB adapter and future stacked store layers.

## 9. IndexedDB Adapter

### 9.0 Schema registration + index creation

- `IndexedDbAdapter` requires a list of `{ schema }` registrations plus an `endpointName`.
- Registered schemas must have **unique, non-empty schema names**.
- On open, the adapter computes a **schema fingerprint** across all registered schemas
  (`schema.name`, `schema.version`, and index definitions). If the fingerprint changes, bump the
  IndexedDB version by **1** (monotonic) and persist the new fingerprint in `lofi_meta` under
  `${endpointName}::schema_fingerprint`.
- Index definitions are derived from Fragno schema indexes using the migration generator
  (`generateMigrationFromSchema`). For each `add-index` operation, create an IndexedDB index on
  `lofi_rows`.

Index key construction (sketch):

- Each row stores **SQLite-normalized** values per column under `_lofi.norm` using
  `sqliteStorageDefault` rules:
  - `date`/`timestamp`: epoch-ms numbers
  - `bool`: 0/1
  - `bigint`: 8-byte big-endian bytes (use `Uint8Array`, not `Buffer`)
  - `reference`/`internal-id`: numbers (throw if beyond MAX_SAFE_INTEGER)
  - `binary`: `Uint8Array` lexicographic compare
- Each IDB index uses a keyPath array:
  - `["endpoint", "schema", "table", "_lofi.norm.<col1>", "_lofi.norm.<col2>", "id"]`
  - The `id` suffix provides a deterministic tie-breaker for pagination.
- Index names are **fully qualified** with schema and table to avoid collisions, e.g.:
  - `idx__${schemaName}__${table}__${indexName}`

If the schema fingerprint changes, the adapter reopens the database at the new version and applies
index creation changes in the `onupgradeneeded` handler. The adapter MUST ensure new indexes are
populated. It must either (a) rebuild all `lofi_rows` (recompute `_lofi.norm` and reinsert so IDB
indexes fill), or (b) clear `lofi_rows` and `lofi_inbox` for this endpoint and force a resync
(default behavior).

When rows are cleared, the adapter MUST also clear the cursor key for this endpoint so the next
`syncOnce()` omits `afterVersionstamp`.

Versioning algorithm (sketch):

1. Open the DB **without** specifying a version to read the current version.
2. Read `${endpointName}::schema_fingerprint` from `lofi_meta` (if present).
3. If the fingerprint differs, close and reopen with `currentVersion + 1`.
4. In `onupgradeneeded`, apply new index creation and update the fingerprint in `lofi_meta`.

### 9.1 Database layout

- One IndexedDB database per Lofi client (configurable name).
  - Default `dbName` should include `endpointName` (e.g. `fragno_lofi_${endpointName}`) to avoid
    collisions.
  - Stores are keyed by `[endpoint, schema, ...]` so one DB can safely host multiple endpoints.
    Object stores:
- `lofi_meta` (key-value storage, endpoint-prefixed keys)
- `lofi_rows` (all data rows)
- `lofi_inbox` (idempotent ingestion tracking)

`lofi_meta` keys are prefixed with `${endpointName}::` and include:

- `${endpointName}::outbox` (cursor)
- `${endpointName}::schema_fingerprint`
- `${endpointName}::seq::<schema>::<table>` (local internal ID counter)

Record shape for `lofi_rows`:

```
{
  key: [string, string, string, string]; // [endpoint, schema, table, id]
  endpoint: string; // endpoint name
  schema: string; // schema name
  table: string;
  id: string; // external ID
  data: Record<string, unknown>;
  _lofi: {
    versionstamp: string;
    norm: Record<string, unknown>;
    internalId: number; // local internal ID (monotonic per table)
    version: number; // local row version (incremented on each update)
  };
}
```

Reference column values are stored in `data` as **external ID strings** and resolved to local
internal IDs when evaluating conditions or producing query results.

Indexes:

- Primary key: `key`
- Secondary index: `idx_schema_table` on `["endpoint", "schema", "table"]` to fetch all rows for a
  table.
- Per-table schema indexes (see §9.0).

`lofi_inbox` record shape:

```
{
  key: [string, string]; // [sourceKey, versionstamp]
  sourceKey: string;
  versionstamp: string; // outbox entry versionstamp
  receivedAt: number; // epoch ms
}
```

Indexes:

- Primary key: `key`
- Unique index: `idx_inbox_source_version` on `["sourceKey", "versionstamp"]`

### 9.3 Apply semantics

- `create`: upsert by `externalId` (idempotent replays).
- `update`: shallow-merge `set` into `data`; **no-op** if row is missing.
- `delete`: remove row; **no-op** if row is missing.
- `_lofi.norm` values are recomputed for indexed columns on every create/update.
- `_lofi.internalId` is assigned on first create (monotonic per table, stored in `lofi_meta`).
- `_lofi.version` starts at `1` and increments on each applied update for that row.
- Inbox writes are part of the same IDB transaction as row updates.
- `applyOutboxEntry` checks the inbox unique index and returns `{ applied: false }` without mutating
  rows when the entry already exists.
- If a mutation targets an unregistered schema or table, throw and do not record the inbox entry.

## 10. Local Query Engine

### 10.1 Data model for queries

- Query results are built from `lofi_rows.data` plus `id`.
- ID columns return `FragnoId` with **local** internal IDs and local row versions.
- Reference columns return `FragnoReference` resolved from **local** internal IDs. If a reference
  cannot be resolved locally, return `null` for that column.
- Local internal IDs are only used inside the client store and are not equal to server internal IDs.
- Local internal IDs are stored as numbers and converted to `bigint` when constructing
  `FragnoId`/`FragnoReference`.

### 10.2 Query API semantics

- Read-only; no `create/update/delete` methods.
- Builder surface mirrors UnitOfWork `FindBuilder`:
  - `whereIndex`, `orderByIndex`, `after`, `before`, `pageSize`
  - `select`, `selectCount`, `join`
- `whereIndex` is required (mirrors UnitOfWork requirements).
- Cursor pagination uses `Cursor` semantics from `@fragno-dev/db`.
- `selectCount` returns a number (same behavior as server query engines).
- `whereIndex("primary")` maps to the `lofi_rows` primary key ordering
  `[endpoint, schema, table, id]`. `orderByIndex("primary")` uses the same ordering and cursor
  generation uses `id` as the final tie-breaker.

### 10.3 Evaluation approach (initial)

1. Resolve the index from `whereIndex`.
2. If an IDB index exists for that schema index, use an IDB cursor over the index; otherwise fall
   back to `idx_schema_table` scan.
3. Build the `Condition` from the builder callback and filter rows in memory using Lofi-specific
   evaluation:
   - Reference columns are resolved via local internal IDs (lookup by external ID).
   - Comparing a reference column to an external ID performs a lookup; if missing, treat as false.
4. Sort rows using Lofi normalization and index ordering rules.
5. Apply cursor + page size to compute `CursorResult`.

### 10.4 Join semantics

- Joins follow the same nested-join semantics as the in-memory adapter.
- Relation comparisons use **local internal IDs**:
  - If the relation targets an internal-ID column, compare using the local internal ID.
  - External IDs are resolved to local internal IDs via lookup.

This favors correctness and reuse of server semantics over raw performance.

## 11. Testing Strategy

- Use Vitest with `fake-indexeddb` to provide `indexedDB` in Node.
- Adapter tests:
  - create/update/delete idempotency
  - cursor persistence in `lofi_meta` (endpoint-scoped keys)
  - refMap resolution behavior (shallow only)
  - schema + endpoint scoping in keys
- Poller integration tests:
  - Use a test backend that emits real outbox entries by **adding outbox support to the in-memory
    adapter** in `@fragno-dev/db`.
  - Add tests for the in-memory outbox behavior itself (ordering + payload shape).
  - Validate ordering and cursor progression with multiple entries.
  - Validate query engine results (whereIndex/orderByIndex/cursor/joins/selectCount).
  - Validate inbox idempotency (same outbox entry ingested twice).

## 12. Future Work (Not Implemented Here)

- Stacked data store (in-memory override + IndexedDB base) following the Wilcofirst design.
- Local writes with conflict detection and rebase.
- Cross-tab sync via `BroadcastChannel`.
- Query performance optimizations (partial index scans, range queries, streaming joins).
