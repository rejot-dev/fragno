# Fragno DB Outbox — Spec

## 0. Open Questions

None.

## 1. Overview

This document specifies an **optional Outbox** for `@fragno-dev/db` Unit of Work (UOW) mutation
batches. The outbox records UOW mutations **in commit order** using a **global versionstamp** stored
in the existing internal settings table (`fragno_db_settings`).

The outbox:

- Is **disabled by default** and **opt-in by the user** (the app integrator), not by fragment
  authors.
- Records one outbox entry **per successful UOW mutation batch** (not per row).
- Guarantees ordering via a **global, monotonic versionstamp** reserved inside the same transaction
  that applies the mutations.
- Exposes a programmatic retrieval API for testing and external consumers.

## 2. References

- Internal settings fragment + schema: `packages/fragno-db/src/fragments/internal-fragment.ts`
- Unit of Work types + mutation ops: `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts`
- SQL UOW executor (transaction boundary):
  `packages/fragno-db/src/adapters/generic-sql/generic-sql-uow-executor.ts`
- SQL operation compiler (update increments `_version`):
  `packages/fragno-db/src/adapters/generic-sql/query/sql-query-compiler.ts`
- Driver config capabilities (database type):
  `packages/fragno-db/src/adapters/generic-sql/driver-config.ts`
- SQL adapter entry point: `packages/fragno-db/src/adapters/generic-sql/generic-sql-adapter.ts`

## 3. Terminology

- **Outbox entry**: A single persisted record representing one UOW mutation batch.
- **Outbox versionstamp**: A global, monotonically increasing value used to totally order outbox
  entries, formatted like FoundationDB versionstamps (10‑byte transaction version + 2‑byte user
  version).
- **UOW batch**: The set of mutation operations executed by a Unit of Work’s mutation phase.
- **Consumer**: A process that reads outbox entries and applies them to another store.

## 4. Goals / Non-goals

### 4.1 Goals

1. **Total order**: Outbox entries reflect the same commit order as the primary database.
2. **Atomicity**: Mutations and outbox insertions succeed or fail together.
3. **Opt-in**: Outbox is disabled by default and enabled by the user in adapter configuration.
4. **Cross‑DB support**: The outbox versionstamp reservation uses the most logical approach per SQL
   database type, decided by `DriverConfig`.
5. **Programmatic retrieval**: There is an API to list outbox entries for tests and consumers.

### 4.2 Non-goals

- Building a full sync protocol or replication worker.
- Automatic outbox cleanup or retention policies.
- Guaranteeing cross-DB type fidelity beyond JSON‑safe serialization.

## 5. Design

### 5.1 Enablement (user-controlled)

- Outbox support is **disabled by default**.
- Users enable it by passing outbox configuration to the SQL adapter, e.g. via `SqlAdapterOptions`.
- Fragment authors do **not** control outbox behavior.

### 5.2 Global outbox versionstamp (settings table)

- The outbox transaction version lives in `fragno_db_settings` (internal settings table).
- Key: `${SETTINGS_NAMESPACE}.outbox_version` (value is a stringified integer; parse as unsigned
  bigint to cover the 80‑bit range).
- The version row is created lazily on first use (via upsert) if it doesn’t exist.
- The transaction version is **reserved at the start of the mutation transaction** and held until
  commit.
- The full **versionstamp** matches FoundationDB’s format:
  - **Transaction version**: 10‑byte, big‑endian, monotonic integer.
  - **User version**: 2‑byte, big‑endian, per‑mutation counter (`0, 1, 2, ...`).
  - Encoding: transaction version is the unsigned integer from `fragno_db_settings` padded to 10
    bytes big‑endian; user version is a 16‑bit unsigned integer padded to 2 bytes.

### 5.3 Outbox versionstamp reservation (per database type)

Version reservation must be decided by
`packages/fragno-db/src/adapters/generic-sql/driver-config.ts` via a new strategy field or method.
The executor uses that strategy to issue the correct SQL.

Recommended strategies:

- **PostgreSQL (pg, pglite)**
  - Single statement using `UPDATE ... RETURNING` (or `INSERT ... ON CONFLICT ... RETURNING` to
    create row on first use).
  - Example (conceptual):
    - `INSERT INTO fragno_db_settings (id, key, value) VALUES ($id, $key, '0') ON CONFLICT (key) DO UPDATE SET value = (fragno_db_settings.value::bigint + 1)::text RETURNING value;`

- **SQLite (sqlocal, better-sqlite3, cloudflare_durable_objects)**
  - Use `BEGIN IMMEDIATE` implicitly via the transaction wrapper (single-writer).
  - Prefer `UPDATE ... RETURNING` or `INSERT ... ON CONFLICT ... RETURNING`.

- **MySQL (mysql2)**
  - Use `INSERT ... ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(CAST(value AS UNSIGNED) + 1);`
  - Then `SELECT LAST_INSERT_ID();`

**Guarantee:** Because the version row is locked and updated inside the transaction, outbox entries
are emitted in the same order as commits for all outbox-enabled UOWs.

### 5.4 Outbox table schema

Add a new internal table to the internal schema:

- **Table name**: `fragno_db_outbox`
- **Columns**:
  - `id` (external id, `idColumn()`)
  - `versionstamp` (`binary`, not null, indexed, unique preferred) — 12‑byte FDB‑format versionstamp
    (10‑byte transaction version + 2‑byte user version, user version = 0 for the outbox row).
    Ordering uses lexicographic byte order (big‑endian).
  - `uowId` (`string`, not null) — from `UnitOfWork.idempotencyKey`
  - `payload` (`json`, not null) — serialized mutation batch
  - `refMap` (`json`, nullable) — reference placeholder map (plain JSON, see §5.8)
  - `createdAt` (`timestamp`, not null, default now)
- **Indexes**:
  - `idx_outbox_versionstamp` on `versionstamp`
  - `idx_outbox_uow` on `uowId`

The outbox table is created as part of the internal schema migrations and exists regardless of
whether outbox is enabled. No outbox rows are written unless enabled. Outbox entries do not store a
top‑level namespace; namespaces live on each mutation item.

### 5.5 Outbox payload format

Outbox payloads store **logical mutation operations** using external IDs and user-facing column
names (ORM names). This keeps payloads portable across databases.

```ts
export type OutboxPayload = {
  version: 1;
  mutations: OutboxMutation[];
};

export type OutboxMutation =
  | {
      op: "create";
      schema: string; // schema identifier (equals namespace)
      namespace?: string;
      table: string;
      externalId: string;
      versionstamp: string; // 12-byte FDB-format versionstamp, hex-encoded (24 chars, lowercase)
      values: Record<string, unknown>; // ORM names
    }
  | {
      op: "update";
      schema: string; // schema identifier (equals namespace)
      namespace?: string;
      table: string;
      externalId: string;
      versionstamp: string; // hex-encoded
      set: Record<string, unknown>; // ORM names
      checkVersion?: number; // if .check() was used
    }
  | {
      op: "delete";
      schema: string; // schema identifier (equals namespace)
      namespace?: string;
      table: string;
      externalId: string;
      versionstamp: string; // hex-encoded
      checkVersion?: number; // if .check() was used
    };
```

Rules:

- **One outbox entry per UOW mutation batch**, preserving the order of mutations as recorded by the
  UOW.
- Each mutation gets a unique **user version** (0, 1, 2, ...) inside the same transaction version.
  The `versionstamp` field is the 10‑byte transaction version plus the 2‑byte user version.
  Serialize versionstamps to **lowercase hex** when stored in JSON payloads.
- `check` operations are **not** emitted (they are internal preconditions only).
- Mutations targeting internal fragment tables (e.g. `fragno_db_settings`, `fragno_hooks`,
  `fragno_db_outbox`) are **not** emitted.
- The `schema` field equals the fragment namespace for the mutation.
- All ID values in payloads must be **external IDs**. If a value contains `FragnoId` or
  `FragnoReference`, serialize it to its external ID.
- Payload values must be JSON-safe (serialize `Date`, `bigint`, etc. consistently across DBs).
- Payloads are serialized with **superjson**. The outbox `payload` column stores the full superjson
  output (`{ json, meta }`), and `refMap` remains plain JSON (see §5.8).

### 5.6 UOW integration

When outbox is enabled:

1. **Begin transaction**.
2. **Reserve outbox transaction version** (first statement) using driver-config strategy.
3. Execute compiled mutation batch.
4. Insert outbox row with the reserved versionstamp and serialized payload.
5. **Commit**.

If any mutation fails or a version conflict is detected, the transaction rolls back and no outbox
entry is written (version increment rolls back as well).

### 5.7 Programmatic retrieval API

Expose an internal fragment service to list outbox entries for testing and consumers.

```ts
outboxService.list({
  afterVersionstamp?: string; // hex-encoded
  limit?: number;
}): Promise<OutboxEntry[]>;
```

- Results are ordered by `versionstamp` ascending.
- `afterVersionstamp` filters entries with versionstamp > provided value (bytewise comparison).
- The API is available even if outbox is disabled; it just returns no rows.

### 5.8 Reference placeholders + `refMap` (external ID recovery)

Some reference values may only be available as **internal IDs** at mutation time (e.g. when a
`FragnoReference` or a `FragnoId` with `internalId` is used). The outbox must not expose internal
IDs, but still needs a way to carry the external ID.

**Solution:** Use placeholders in `payload` plus a separate `refMap` column.

- If a reference value has a known external ID, emit it directly in `payload`.
- If a reference value is **internal-only**, emit a placeholder object in `payload`:

```json
{ "__fragno_ref": "<opIndex>.<columnName>" }
```

- Add a plain JSON `refMap` column that maps the placeholder key to the external ID:

```json
{ "0.authorId": "user_cuid_abc" }
```

**Why this is needed**

- Reference columns are stored as internal IDs in the database.
- `FragnoReference` objects only carry internal IDs.
- We must avoid leaking internal IDs to external consumers.

**When/How to populate `refMap`**

- During the mutation transaction, **after** applying mutations and **before** inserting the outbox
  row, run lookup queries that resolve internal IDs to external IDs for reference fields.
- These lookup queries are derived from the logical mutation ops (schema + column metadata), so the
  compiler/executor must carry a small “post‑mutation lookup” plan through to execution.

## 6. Public/Adapter API surface

### 6.1 SQL Adapter configuration

Add an opt‑in outbox config to `SqlAdapterOptions`:

```ts
export type OutboxConfig = {
  enabled: boolean;
};

export interface SqlAdapterOptions {
  // existing fields...
  outbox?: OutboxConfig;
}
```

`enabled` defaults to `false`.

### 6.2 DriverConfig additions

Add a driver-config selector for versionstamp reservation strategy, e.g.:

```ts
export type OutboxVersionstampStrategy =
  | "update-returning"
  | "insert-on-conflict-returning"
  | "insert-on-duplicate-last-insert-id";

abstract readonly outboxVersionstampStrategy: OutboxVersionstampStrategy;
```

Each concrete driver config chooses the most logical strategy for its database type.

## 7. Error Handling

- If outbox is enabled but the versionstamp reservation fails (e.g. missing settings table), bubble
  the error and fail the UOW mutation (no partial writes).
- If payload serialization fails, the UOW mutation fails and the transaction rolls back.

## 8. Migration + Backwards Compatibility

- Internal schema version increments to add `fragno_db_outbox`.
- Existing databases must apply the internal migration before enabling outbox.
- Outbox is optional; existing users are unaffected unless they opt in.
