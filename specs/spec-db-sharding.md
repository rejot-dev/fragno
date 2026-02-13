# Fragno DB Sharding — Spec

## 0. Open Questions

None.

## 1. Overview

This spec introduces **server‑only sharding** for `@fragno-dev/db` without involving namespaces or
clients. Namespaces remain a fragment‑author tool for table name collisions only. Lofi and other
clients remain **schema‑only** and receive shard‑scoped outbox data from the server.

Core changes:

- Add a **hidden `_shard` column** (nullable) to every table alongside `_internalId` and `_version`.
- Add a **sharding strategy** in `FragnoPublicConfigWithDatabase` (integrator‑controlled only).
- Inject shard filtering into **Unit of Work** reads/writes when row‑sharding is enabled.
- Ensure **internal tables** use `_shard` (implicit system column) and are filtered by shard on
  internal routes.
- Keep **global outbox versioning** (per adapter) while shard‑scoping reads/writes.
- Add **system migrations** for implicit shard columns (outside the built‑in migration engine).

## 2. References

- Namespaces + naming strategy: `specs/spec-db-namespace-and-naming.md`
- Outbox spec: `specs/spec-outbox.md`
- Lofi spec: `specs/spec-lofi.md`
- Schema builder + system columns: `packages/fragno-db/src/schema/create.ts`
- Unit of Work operations: `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts`
- Request context storage + middleware: `packages/fragno/src/api/request-context-storage.ts`,
  `packages/fragno/src/api/request-middleware.ts`,
  `packages/fragno/src/api/fragment-instantiator.ts`
- Database fragment context wiring: `packages/fragno-db/src/db-fragment-definition-builder.ts`,
  `packages/fragno-db/src/adapters/adapters.ts`
- SQL adapter + executor: `packages/fragno-db/src/adapters/generic-sql/generic-sql-adapter.ts`,
  `packages/fragno-db/src/adapters/generic-sql/generic-sql-uow-executor.ts`
- In-memory adapter: `packages/fragno-db/src/adapters/in-memory/in-memory-uow.ts`
- Internal fragment + outbox routes: `packages/fragno-db/src/fragments/internal-fragment.ts`,
  `packages/fragno-db/src/fragments/internal-fragment.routes.ts`,
  `packages/fragno-db/src/fragments/internal-fragment.schema.ts`
- Sync submit + conflict checker: `packages/fragno-db/src/sync/submit.ts`,
  `packages/fragno-db/src/sync/conflict-checker.ts`
- Durable hooks processor: `packages/fragno-db/src/hooks/durable-hooks-processor.ts`
- Adapter registry: `packages/fragno-db/src/internal/adapter-registry.ts`
- Lofi IndexedDB adapter + client: `packages/lofi/src/indexeddb/adapter.ts`,
  `packages/lofi/src/client/client.ts`

## 3. Terminology

- **Shard**: Logical partition key (e.g. tenant ID) for a fragment’s data.
- **Shard column**: Hidden `_shard` column added to every table.
- **Shard context**: Request‑scoped shard value used by the UOW.
- **Sharding strategy**: Integrator‑provided policy that controls row‑level filtering vs
  adapter‑level sharding.
- **System migration**: A migration that **cannot** be handled by the built‑in migration engine
  (because it depends on implicit columns). These are implemented separately and invoked explicitly.
  The current codebase refers to these as “internal migrations” (renaming tracked as follow‑up).

## 4. Goals / Non-goals

### 4.1 Goals

1. Enable **server‑only sharding** without exposing shard or namespace concepts to clients.
2. Ensure every table stores a **nullable `_shard` column**.
3. Provide a **pluggable sharding strategy** in `FragnoPublicConfigWithDatabase` (integrator‑only).
4. Inject **row‑level shard filters** in UOW operations when enabled.
5. Filter **outbox + sync + hooks** by shard on the server.
6. Disallow **cross‑shard joins** (enforced by shard filtering or explicit errors).
7. Make **conflict checking** shard‑scoped in row‑mode.

### 4.2 Non-goals

- Client‑visible shard APIs or routing.
- Cross‑shard queries or fan‑out.
- Any coupling between namespace and shard.
- Automatic shard resolution; integrators must set shard via middleware.
- Per‑shard outbox clocks (deferred).

## 5. Sharding Strategy

### 5.1 Types

```ts
export type ShardingStrategy = { mode: "row" } | { mode: "adapter"; identifier: string };

export type FragnoPublicConfigWithDatabase = FragnoPublicConfig & {
  shardingStrategy?: ShardingStrategy;
};
```

Rules:

- **No sharding** if `shardingStrategy` is omitted.
- `identifier` is required only for `mode: "adapter"`.
- The shard column is always `_shard` (no custom column names).
- Fragment authors do **not** control this; only integrators (fragment users) set it. The
  `identifier` value is for diagnostics/observability only and is not stored in the database.
  Adapters do not expose their own sharding configuration; the strategy comes from
  `FragnoPublicConfigWithDatabase` and is cached per adapter by the registry.
- Sharding strategy is **adapter‑scoped**: the first non‑undefined strategy registered for an
  adapter is locked in. Any attempt to register a different strategy for the same adapter
  **throws**.

### 5.2 Strategy Semantics

- `mode: "row"` — row‑level shard filtering enforced by UOW.
- `mode: "adapter"` — no row‑level filtering (the adapter/database is the shard boundary), but
  `_shard` is still written for traceability. Integrators should always set shard in adapter mode
  (e.g. Durable Object ID) so rows can be traced back to their shard.

### 5.3 Internal Fragment Propagation

The internal fragment is created by the adapter registry. It must receive the **same**
`shardingStrategy` used by user fragments so that internal routes (`/_internal/outbox`,
`/_internal/sync`) are filtered consistently. The registry should capture the first non‑undefined
strategy for an adapter and reuse it for the internal fragment instance. If another fragment
attempts to register a different strategy for the same adapter, throw immediately.

## 6. Shard Context API

### 6.1 Request Storage (Adapter Context)

Database fragments already share an adapter-level `RequestContextStorage`:

- The adapter exposes `contextStorage` (`packages/fragno-db/src/adapters/adapters.ts`).
- `DatabaseFragmentDefinitionBuilder` uses `withExternalRequestStorage` to reuse that storage and
  wraps each request with `withRequestStorage`
  (`packages/fragno-db/src/db-fragment-definition-builder.ts`).
- `FragmentInstantiator.handler()` wraps **middleware + handler** execution in
  `#withRequestStorage`, so middleware runs inside the same request context
  (`packages/fragno/src/api/fragment-instantiator.ts`).

We extend both request storage types so shard is stored in the same shared context:

```ts
export type DatabaseContextStorage = {
  uow: IUnitOfWork;
  shard: string | null;
  shardScope: "scoped" | "global";
};

export type DatabaseRequestStorage = {
  uow: IUnitOfWork;
  shard: string | null;
  shardScope: "scoped" | "global";
};
```

`DatabaseFragmentDefinitionBuilder.withRequestStorage(...)` must initialize `{ shard: null }` and
`{ shardScope: "scoped" }` for every request.

### 6.2 Handler/Service Context Helpers

Expose on `DatabaseHandlerContext` and `DatabaseServiceContext`:

```ts
getShard(): string | null;
setShard(shard: string | null): void;
withShard<T>(shard: string | null, fn: () => T | Promise<T>): T | Promise<T>;
getShardScope(): "scoped" | "global";
setShardScope(scope: "scoped" | "global"): void;
withShardScope<T>(scope: "scoped" | "global", fn: () => T | Promise<T>): T | Promise<T>;
```

Constraints:

- `shard === null` means “no shard.”
- `shard` must be **non‑empty** and **<= 64 chars** when set (throw otherwise).
- `shardScope` defaults to `"scoped"`. `"global"` disables row‑level shard filters and is reserved
  for internal maintenance (e.g. global hook processors).

Implementation hook‑up (from current code structure):

- `DatabaseFragmentDefinitionBuilder.withThisContext(...)` is the only place that can create
  handler/service `this` contexts. It already receives the shared `storage` object. We add
  `getShard/setShard/withShard` there by reading/writing `storage.getStore().shard`.
- The helper implementation is shared with middleware via a small wrapper around
  `RequestContextStorage<DatabaseContextStorage>`.
- **No middleware API change is required**: middleware already receives a second `output` argument
  (`RequestMiddlewareOutputContext`) that exposes `deps` and `services`. `shardContext` is added to
  the implicit DB deps, so it is reachable at `output.deps.shardContext`.

```ts
const createShardContextHelpers = (
  storage: RequestContextStorage<DatabaseContextStorage>,
): ShardContextHelpers => ({
  get: () => storage.getStore().shard,
  set: (shard) => {
    validateShard(shard);
    storage.getStore().shard = shard;
  },
  with: async (shard, fn) => {
    validateShard(shard);
    const store = storage.getStore();
    const prev = store.shard;
    store.shard = shard;
    try {
      return await fn();
    } finally {
      store.shard = prev;
    }
  },
});
```

Expose the same helpers to middleware via implicit deps (middleware only receives `deps` +
`services` from `RequestMiddlewareOutputContext`, not `this`):

```ts
type ShardContextHelpers = {
  get(): string | null;
  set(shard: string | null): void;
  with<T>(shard: string | null, fn: () => T | Promise<T>): T | Promise<T>;
  getScope(): "scoped" | "global";
  setScope(scope: "scoped" | "global"): void;
  withScope<T>(scope: "scoped" | "global", fn: () => T | Promise<T>): T | Promise<T>;
};

export type ImplicitDatabaseDependencies<TSchema> = {
  // ...existing deps...
  shardContext: ShardContextHelpers;
};
```

`shardContext` is created from `databaseAdapter.contextStorage` inside
`DatabaseFragmentDefinitionBuilder` when implicit deps are assembled, so it shares the exact request
context that handlers/services use.

### 6.5 Direct `deps.db` Access

When `shardingStrategy` is set (either mode), the implicit `deps.db` query engine is **disabled**
and must throw if accessed. Sharded deployments must use `handlerTx/serviceTx` so shard context is
always enforced.

### 6.3 Middleware Example (Required)

Shard is resolved by integrator‑provided middleware. This must run for **all fragments**, including
internal routes (`/_internal/outbox`, `/_internal/sync`).

```ts
const shardMiddleware = async (input, output) => {
  const shard = input.headers.get("x-fragno-shard");
  if (shard && shard.length > 64) {
    return Response.json({ error: "Shard too long" }, { status: 400 });
  }

  // Uses request storage already initialized by the fragment runtime.
  output.deps.shardContext.set(shard ?? null);
};

fragment.withMiddleware(shardMiddleware);
getInternalFragment(adapter).withMiddleware(shardMiddleware);
```

### 6.4 Handler/Service Examples

```ts
// Read the current shard
const shard = this.getShard();

// Adapter-mode example (e.g. Durable Object instance name)
this.setShard(this.ctx.id.toString());

// Temporarily switch shard for a scoped operation
await this.withShard("tenant_42", async () => {
  await this.handlerTx()
    .mutate(({ uow }) => uow.create("items", { name: "Hello" }))
    .execute();
});
```

## 7. Data Model Changes

### 7.1 System Column `_shard`

- Add `_shard` as a **hidden**, **nullable** string column to every table.
- This is a **system column** added implicitly alongside `_internalId` and `_version`.
- The column is associated with `idColumn()` (system columns only exist on tables with an id).

### 7.2 Shard Index

Create a shard index for every table to support row‑level filtering:

- Logical name: `idx_${tableName}_shard`
- Columns: `[_shard]`

### 7.3 Internal Tables

Internal tables use the same implicit `_shard` system column (via `idColumn()`), so no explicit
column declarations are required. Add indexes to support shard‑filtered scans, e.g.

- `idx_outbox_shard_versionstamp` on `(_shard, versionstamp)`
- `idx_outbox_mutations_shard_entry` on `(_shard, entryVersionstamp)`
- `idx_sync_requests_shard_request` on `(_shard, requestId)`
- `idx_hooks_shard_status_retry` on `(_shard, status, nextRetryAt)`

### 7.4 Adapter‑Scoped Settings Table

`fragno_db_settings` is **adapter‑scoped**, not shard‑scoped:

- Rows are written with `_shard = null`.
- UOW shard filtering is **disabled** for this table even in `mode: "row"`.

## 8. UOW Shard Injection

### 8.1 Create Operations

- When `shardingStrategy` is set:
  - If `_shard` is missing in values, inject it from shard context.
  - Reject writes that explicitly set `_shard` (system column).
- For `mode: "adapter"`, shard **must** be set (non‑null) so rows are traceable to their shard. This
  validation is skipped when `shardScope === "global"` (internal maintenance only).

### 8.2 Update/Delete/Check Operations

- When `shardingStrategy.mode === "row"`, add `_shard = :shard` to update/delete/check queries.
- If shard is `null`, the filter becomes `_shard IS NULL`.
- If `shardScope === "global"`, **do not** inject shard filters (internal maintenance only).
- Adapter‑scoped tables (e.g. `fragno_db_settings`) are exempt from shard filters.

### 8.3 Retrieval Operations

- When `shardingStrategy.mode === "row"`, wrap the retrieval `where` clause with `_shard = :shard`.
- If no `where` clause exists, inject it.
- If `shardScope === "global"`, **do not** inject shard filters (internal maintenance only).
- Adapter‑scoped tables (e.g. `fragno_db_settings`) are exempt from shard filters.

### 8.4 Join Operations

Cross‑shard joins are disallowed. In `mode: "row"`, the compiler must ensure **every table in the
join tree** is filtered by `_shard = :shard`. If it cannot enforce this (e.g. unsupported join path
in the adapter), it must throw during compilation.

## 9. Outbox + Sync (Shard Scoping)

### 9.1 Outbox Write Path

- Outbox rows and mutation rows include `_shard`.
- Payload format is unchanged; `_shard` values may appear in mutation payloads (system column), and
  clients must ignore them.

### 9.2 Outbox Read Path

- `/_internal/outbox` must filter by shard when a sharding strategy is enabled.
- Sync submit uses shard‑filtered outbox lists and mutation counts.

### 9.3 Outbox Versioning (Global, For Now)

Outbox versioning remains **global per adapter** using the existing settings key
`${SETTINGS_NAMESPACE}.outbox_version`. This is intentionally unchanged for now. Add a TODO comment
near outbox version reservation to revisit per‑shard versioning later.

### 9.4 Conflict Checking

In `mode: "row"`, the conflict checker must be **shard‑scoped**:

- `_shard = :shard` is added to `fragno_db_outbox_mutations` lookups.
- Join‑based conflict checks must enforce shard filters on every joined table (same rule as UOW
  joins).

## 10. Hooks Sharding

- `fragno_hooks` rows include `_shard`.
- Hook scheduling/processing must only operate on the current shard when `mode: "row"`.
- When `mode: "adapter"`, hooks still write shard for traceability but do not filter in SQL.

### 10.1 Durable Hooks Processor Modes

`createDurableHooksProcessor` gains an option to run **per shard** or **globally**:

```ts
type DurableHooksProcessorScope =
  | { mode: "shard"; shard: string | null }
  | { mode: "global" };

createDurableHooksProcessor(fragment, { scope?: DurableHooksProcessorScope });
```

Behavior:

- `mode: "shard"` sets shard context and runs with `shardScope = "scoped"`.
- `mode: "global"` sets `shardScope = "global"` (no row‑level shard filters) so a single processor
  can drain hooks across all shards.

## 11. Local‑First / Lofi

- Lofi remains shard‑agnostic and only receives shard‑filtered data from server endpoints.
- `_shard` is hidden, so local query results never expose it.
- Outbox mutation payloads may include `_shard`; clients must ignore it.

## 12. Migration / Compatibility

### 12.1 System Migration (implicit shard column)

Because `_shard` is implicit (not declared in schema code), existing tables **will not** be updated
by the built‑in migration engine. We need a **system migration** that:

- Scans all tables that contain an `idColumn()`.
- Adds `_shard` (nullable) and its index if missing.

### 12.2 Internal Schema Migration

Outbox/sync/hooks tables are part of the internal schema; their **shard indexes** should be added
via normal `alterTable` operations so the **built‑in migration engine** can generate migrations.
System migrations must run before these index migrations.

### 12.3 Outbox Version Migration

No migration is required while outbox versioning remains global.

## 13. Testing

- UOW shard injection tests (create/update/delete/find/check).
- SQL + in‑memory adapter tests for row vs adapter strategy.
- Outbox route tests to ensure shard filtering (including middleware on internal routes).
- Sync + conflict checker tests for shard‑scoped scans.
- Hooks tests for shard scoping and global processor mode.
- Join tests: ensure shard filtering across joins or throw on unsupported joins.
- `deps.db` usage throws when shardingStrategy is set.
- Lofi tests updated for new hidden `_shard` column and shard‑filtered outbox responses.

## 14. Decisions (Locked)

- Namespace is **not** shard.
- Clients remain **schema‑only** and shard‑agnostic.
- `_shard` is a **hidden**, **nullable** system column on every table.
- Sharding is **disabled** if `shardingStrategy` is omitted.
- Sharding strategy is **integrator‑only**; fragment authors do not control it.
- Sharding strategy is **adapter‑scoped**; mismatches throw.
- Outbox versioning stays **global** (per adapter) for now.
- Internal tables use the implicit `_shard` system column.
- `fragno_db_settings` is **adapter‑scoped** (no shard filtering).
- Cross‑shard joins are **disallowed**.
- `deps.db` is **disabled** when shardingStrategy is set.
- Outbox payloads may include `_shard` (system column) and clients must ignore it.
- System migrations are used for implicit shard columns (and run before internal index migrations).

## 15. Documentation Updates

- Update DB fragment docs to explain sharding strategy and server‑only routing.
- Update Lofi docs to state shard filtering is server‑side only.
