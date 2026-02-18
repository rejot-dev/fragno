# SQLite Stable DB Now for SQL Adapter — Spec

## 0. Open Questions

None.

## 1. Overview

SQLite evaluates `CURRENT_TIMESTAMP`/`julianday('now')` per statement, not per transaction. The
workflow runner updates `workflow_task.runAt` and inserts `fragno_hooks.nextRetryAt` in separate
statements inside the same UOW, so those timestamps can differ by a few milliseconds. This causes
flaky tests and makes “db time only” scheduling appear inconsistent.

This spec makes SQLite’s `DbNow` stable across all mutation statements in a single UOW by seeding a
connection-scoped temp table with a single database timestamp at the start of the mutation
transaction and compiling all SQLite mutation statements to reference that temp table via
subqueries. Retrieval queries keep using SQLite’s native `CURRENT_TIMESTAMP` semantics.

## 2. References

- SQL UOW executor: `packages/fragno-db/src/adapters/generic-sql/generic-sql-uow-executor.ts`
- SQL query compiler: `packages/fragno-db/src/adapters/generic-sql/query/sql-query-compiler.ts`
- UOW operation compiler:
  `packages/fragno-db/src/adapters/generic-sql/query/generic-sql-uow-operation-compiler.ts`
- UOW encoder: `packages/fragno-db/src/adapters/generic-sql/uow-encoder.ts`
- SQLite WHERE builder: `packages/fragno-db/src/adapters/generic-sql/query/where-builder.ts`
- SQLite storage modes: `packages/fragno-db/src/adapters/generic-sql/sqlite-storage.ts`
- External: `specs/references/sqlite-now-argument-stability.md`

## 3. Terminology

- **DbNow**: the `dbNow()` sentinel used in mutation/query builders to represent database time.
- **SQLite temp now table**: a connection-scoped temp table seeded once per mutation transaction and
  referenced by all SQLite `DbNow` expressions in that transaction.
- **DbNow strategy**: centralized, per-dialect rules for rendering `DbNow` in SQL (SQLite vs
  Postgres vs MySQL).

## 4. Goals / Non-goals

### 4.1 Goals

1. Make `DbNow` stable across all SQLite mutation statements in a single UOW.
2. Preserve database-time semantics (no server time fallback).
3. Define per-dialect `DbNow` strategies in a central place.
4. Keep Postgres/MySQL behavior equivalent to current behavior.
5. Respect SQLite storage modes (`epoch-ms` vs `iso-text`).
6. Avoid any public API changes for fragment authors.

### 4.2 Non-goals

- Guaranteeing stable time across _multiple_ transactions.
- Changing retrieval/query semantics for `DbNow` outside mutation transactions.
- Introducing new database backends or altering schema DSL.

## 5. Current State (Context)

- `DbNow` in SQLite is encoded as either `CURRENT_TIMESTAMP`, `datetime('now', …)` or
  `cast((julianday('now') - 2440587.5) * 86400000 as integer)`, depending on storage mode and
  offset.
- Each statement independently evaluates `now`, so two statements in the same transaction can differ
  by a few ms.
- The workflow runner uses separate statements for task scheduling and hook insertion, leading to
  the observed skew.

## 6. Proposed Design

### 6.1 DbNow Strategy Registry (central)

Introduce a centralized `DbNowStrategy` registry keyed by dialect. There is no SQLite-specific mode
toggle. Each dialect has a single strategy that defines how `DbNow` renders in SQL.

Strategies (initial):

- **SQLite**: use a temp-table-backed `DbNow` for mutation statements (stable across statements).
- **Postgres**: use `CURRENT_TIMESTAMP` with interval arithmetic (transaction-stable already).
- **MySQL**: use `CURRENT_TIMESTAMP` / `TIMESTAMPADD` (statement-stable; unchanged behavior).

The strategy is consumed by the SQL adapter’s encoder and WHERE builder. Mutation compilation uses
the dialect’s strategy; retrieval queries keep existing semantics (single-statement stability is
sufficient for reads).

### 6.2 Temp Table Schema

Create a connection-scoped temp table once and refresh it per transaction:

```
CREATE TEMP TABLE IF NOT EXISTS __fragno_now (
  ts_epoch_ms INTEGER NOT NULL,
  ts_text TEXT NOT NULL
);
DELETE FROM __fragno_now;
INSERT INTO __fragno_now (ts_epoch_ms, ts_text)
VALUES (
  cast((julianday('now') - 2440587.5) * 86400000 as integer),
  CURRENT_TIMESTAMP
);
```

Notes:

- The `INSERT` is a single statement, so both columns are consistent.
- The table is connection-scoped; `DELETE` ensures stale values are cleared each transaction.

### 6.3 Encoding DbNow Using the Temp Table

When using the SQLite strategy:

- **epoch-ms storage** (timestamp/date):
  - base: `(SELECT ts_epoch_ms FROM __fragno_now LIMIT 1)`
  - offset: `base + offsetMs`

- **iso-text storage** (timestamp/date):
  - base: `(SELECT ts_text FROM __fragno_now LIMIT 1)`
  - offset: `datetime(base, '+N seconds')` (supports fractional seconds)

This strategy is used in:

- `UnitOfWorkEncoder` (mutation values)
- `where-builder` (mutation WHERE clauses)

### 6.4 Execution Model

- Mutation execution for SQLite runs the temp-table prelude (from the strategy) inside the mutation
  transaction before executing compiled mutations.
- All subsequent mutation statements in that transaction reference the same temp table row,
  producing a stable `DbNow` across statements.
- Retrieval queries remain unchanged and continue using SQLite’s native `now` semantics.

## 7. Implementation Details

### 7.1 New Helpers

Add a shared helper module that defines the per-dialect `DbNowStrategy`, e.g.:

- `getDbNowStrategy(driverConfig)`
- `sqliteNowExpression({ offsetMs, storageMode })`
- `sqliteNowPreludeStatements()`
- constants for temp table/column names

### 7.2 SQL Compiler Updates

- Extend `createSQLQueryCompiler`/`SQLQueryCompiler` to accept a `DbNowStrategy`.
- Use the dialect strategy for mutation compilation (create/update/delete/check).
- Retrieval compilation remains unchanged (single-statement stability is sufficient for reads).

### 7.3 Encoder/Where Updates

- Update `UnitOfWorkEncoder` and `buildWhere` to call into the central strategy.
- Ensure offsets behave identically to existing logic, just with a different base value.

### 7.4 Executor Updates

- In `executeMutation`, when `driverConfig.databaseType === "sqlite"`, execute the prelude
  statements at the start of the transaction before running mutation batch queries.

## 8. Testing

- Add unit tests to validate SQLite `DbNow` SQL generation for both storage modes and offsets.
- Add a SQL adapter test that confirms mutation statements reference `__fragno_now` when compiled in
  SQLite mutation mode.
- Update the workflow runner test to restore strict equality (or near-equality) once the SQLite
  temp-table strategy is in place.

## 9. Operational Concerns

- The temp table is connection-scoped; each connection maintains its own now row.
- The prelude adds three lightweight statements per SQLite mutation transaction.
- No behavior change for other database backends.

## 10. Decisions (Locked)

1. `DbNow` strategies are centralized per dialect and not user-configurable.
2. SQLite mutation statements will read `DbNow` from a temp table seeded per transaction.
3. This is an internal adapter change with no public API changes.

## 11. Documentation Updates

None required (internal change). Update docs only if we later expose configuration.
