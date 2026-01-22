# In-Memory Adapter + OCC Model Checker — Spec

## 0) Open Questions

1. Should trace-based path hashing replace state hashing entirely, or should both be combined (e.g.,
   `stateHash + traceHash`) by default?
2. Should the model checker expose a first-class `traceEvents` output per schedule, or only a
   `traceHash` and let users opt into full traces via a hook?
3. Should runtime nondeterminism (time/randomness) be traced by the model checker by default, or
   only when an explicit `traceRuntime` flag is set?

## 1) Context

Fragno DB uses optimistic concurrency control (OCC) via the UOW two‑phase pattern and `.check()`
version guards. We need deterministic, high‑throughput concurrency testing across the Fragno DB
layer (not just workflows). Existing SQL adapters are correct but too slow and nondeterministic for
exhaustive interleaving exploration.

This spec defines:

- A fully in‑memory `DatabaseAdapter` that matches **SQLite behavior**.
- UOW phase‑boundary instrumentation hooks for interleavings + fault injection.
- A model checker that explores interleavings against the in‑memory adapter.

## 2) Goals

- Deterministic, fast execution of UOW transactions with OCC semantics identical to the SQLite
  adapter.
- Adapter conforms to `DatabaseAdapter` + `SimpleQueryInterface` contracts.
- Deterministic time and ID generation (optional; defaults are usable without explicit config).
- Lightweight BTree‑like indexing so in‑memory queries are fast.
- Model checker operates at **raw UOW** level; service/handler wrappers are optional.

## 3) Non‑Goals

- Production use.
- Full SQL dialect emulation.
- Exact replication of every SQLite edge case (collation, PRAGMAs, etc.).

## 4) API Surface

### 4.1 InMemoryAdapter (new)

Exported from `@fragno-dev/db`.

```ts
export type InMemoryAdapterOptions = {
  clock?: { now: () => Date }; // optional, default uses Date.now
  idGenerator?: () => string; // external ID
  idSeed?: string; // optional seed for cuid2
  internalIdGenerator?: () => bigint; // internal ID
  enforceConstraints?: boolean; // default true
  btreeOrder?: number; // default 32
};

export class InMemoryAdapter implements DatabaseAdapter<InMemoryUowConfig> {
  // ...
}
```

### 4.2 UOW Instrumentation (phase boundaries)

Extend `UnitOfWorkConfig` with instrumentation hooks:

```ts
export type UOWInstrumentation = {
  beforeRetrieve?: (ctx: UOWInstrumentationContext) => void | Promise<void> | Injection;
  afterRetrieve?: (ctx: UOWInstrumentationContext) => void | Promise<void> | Injection;
  beforeMutate?: (ctx: UOWInstrumentationContext) => void | Promise<void> | Injection;
  afterMutate?: (ctx: UOWInstrumentationContext) => void | Promise<void> | Injection;
};

type Injection = { type: "conflict"; reason?: string } | { type: "error"; error: Error };
```

Hooks run at **phase boundaries only** (per‑op is not exposed; phases are atomic units).

Instrumentation context should include at least:

- `phase` (`beforeRetrieve` / `afterRetrieve` / `beforeMutate` / `afterMutate`)
- `uowName` and `idempotencyKey`
- counts of retrieval/mutation ops
- optional access to the underlying `IUnitOfWork` (read‑only) for inspection

## 5) Semantics (SQLite‑aligned)

We follow SQLite behavior as implemented by existing adapters, and the operator semantics defined in
`packages/fragno-db/src/query/condition-builder.ts`.

### 5.1 Storage representation

- Store **application‑level values**, not serialized bytes, to keep the in‑memory store simple.
- For comparisons, indexing, and ordering, compute **SQLite‑normalized keys** using
  `SQLiteSerializer.serialize(...)` (cache in index entries).
- Row record includes:
  - external id (string), `_internalId` (bigint), `_version` (number)
  - column values in application form (Date, boolean, json object, etc.)
  - no DB‑serialized storage; SQLite serialization is only used for comparisons/index keys
- `_internalId` is per‑table (independent counters), matching typical SQLite behavior.

### 5.2 Defaults

- Apply runtime defaults (`defaultTo$`) in memory (clock‑based `now()` uses injected clock).
- Apply database defaults (`defaultTo` and dbSpecial `now`) in memory as well (the in‑memory adapter
  is the DB in tests).

### 5.3 ID generation

- Default external IDs use **seeded cuid2**. If `idSeed` is omitted, use a random seed
  (non‑deterministic), but tests should pass `idSeed` for determinism.
- `idGenerator` can override the default external ID generator.
- `internalIdGenerator` produces monotonically increasing `bigint`.
- Both are optional with defaults.

### 5.4 Condition evaluation

- Use the same operators defined in `condition-builder.ts`: `=`, `!=`, `>`, `>=`, `<`, `<=`, `is`,
  `is not`, `in`, `not in`, `contains`, `starts with`, `ends with`.
- Resolve `FragnoId`/`FragnoReference` using `resolveFragnoIdValue` with SQLite‑normalized keys for
  comparisons.
- Reference columns: when comparing a reference column to an external id (string or `FragnoId`
  without `internalId`), resolve it to internal id via lookup in the referenced table (as SQL
  subquery does). If not found, treat condition as false.
- Numeric columns (`integer`, `decimal`, `bigint`) compare numerically after best‑effort coercion of
  RHS to number/bigint (SQLite‑like numeric affinity).
- String columns compare lexicographically on serialized string values (SQLite‑like).
- Binary/blob compares are lexicographic on bytes (memcmp‑style).
- `is` / `is not` follow SQLite NULL semantics only.
- `in` / `not in` evaluate with `=` semantics against each element in order.

### 5.5 String matching

- Follow SQLite adapter semantics: `contains`, `starts with`, `ends with` map to SQLite `LIKE` with
  `%` and `_`.
- Use **case‑insensitive ASCII** matching (SQLite default).
- Escape handling mirrors SQLite defaults (no explicit ESCAPE support unless added later).

### 5.6 Ordering

- Only `orderByIndex` is supported. Any `orderBy` usage should throw.
- Order by index columns (with primary‑key tie‑breaker for determinism).
- Null ordering: SQLite default (ASC nulls first, DESC nulls last).

### 5.7 Cursor pagination

- Cursor encoding/decoding matches `Cursor` in `query/cursor.ts`.
- `serializeCursorValues` with SQLite driver config is used to compare cursor values against rows.
- For `findWithCursor`, fetch `pageSize + 1`, trim to `pageSize`, set `hasNextPage` and `cursor`
  from the last item.

### 5.8 Joins

- Implement left‑join semantics from `CompiledJoin` (from `buildJoinIndexed`).
- Respect `select`, `where`, `orderByIndex`, and `limit` on joined tables.
- `one` relations return object or null; `many` relations return array.

### 5.9 updateMany / deleteMany semantics

- Match `SimpleQueryInterface` behavior from SQL adapters:
  - `updateMany`: find matching rows (using `whereIndex`) then update each row; if any update fails,
    throw.
  - `deleteMany`: find matching rows then delete each row; if any delete fails, throw.
- `orderBy` is not supported; `whereIndex` is required for `updateMany` (same as current
  implementation).

### 5.10 Retrieval consistency

- Retrieval reads the **current** in‑memory state at `executeRetrieve` time.
- There is no snapshot isolation beyond what `.check()` enforces in the mutation phase.

## 6) In‑Memory Store & Indexing

### 6.1 Store

- Per‑namespace store: table name → row map.
- Row map key is internal id or external id; internal id is preferred for faster joins.
- Separate per‑table internal ID counters.

### 6.2 Indexes (BTREE)

- Implement a **sorted array + binary search** index per index (BTree‑like behavior).
- Keys are tuples of SQLite‑normalized values + external id tie‑breaker.
- Supports insert/remove/update and range scans for cursor and index lookups.
- Unique indexes enforced on insert/update.
- Index maintenance is eager on create/update/delete.
- Range scans are used for `orderByIndex` and cursor pagination.

## 7) Mutation & OCC Semantics

- Create: `_version = 0`, `_internalId` generated.
- Update: `_version++` (always), `.check()` requires version match.
- Delete: `.check()` requires version match.
- `check`: asserts row exists with matching version.
- Version conflicts return `{ success: false }` (same as SQL adapters).
- Mutation phase is atomic per UOW: all mutations apply or none apply.

## 8) Constraint Semantics (same as other adapters)

- Unique/FK violations throw precise errors internally and surface as thrown errors (not
  `{ success: false }`).
- Only version conflicts produce `{ success: false }`.
- Error classes are exported from the in‑memory adapter module for testing and assertions.
- FK semantics match SQLite: nullable FK columns may be null; non‑nullable FK columns must reference
  an existing row.

Suggested error classes (exported):

- `UniqueConstraintError`
- `ForeignKeyConstraintError`
- `NotFoundError` (optional; for operations that expect a row)

## 9) Model Checker

- Lives in `@fragno-dev/test`.
- Operates on raw UOW transactions; handler/service wrappers are optional.
- Modes:
  - **exhaustive** (bounded)
  - **random** (seeded)
  - **infinite** (runs until stopped; can track visited paths and stop if frontier exhausted)
- Path tracking uses a stable hash of DB state + schedule prefix; eviction policy is configurable
  (LRU by default).
- A user‑supplied `stateHasher` can override the default hashing strategy.

### 9.1 Runtime Nondeterminism

Model-checker runs must be able to trace and control nondeterminism from:

- **Time** (`FragnoRuntime.time.now()`).
- **Randomness** (`FragnoRuntime.random.float()` / `uuid()` / `cuid()`).
- Adapter-level ID generation (external IDs + internal IDs).

The model checker must allow injecting a deterministic runtime and optionally emit trace events for
runtime calls (SPEC §9.2).

### 9.2 Trace Recording (optional)

The model checker should support recording a **serializable trace** per schedule that includes:

- UOW retrieve outputs (normalized rows, sorted keys, deterministic order).
- UOW mutation inputs (normalized `MutationOperation` payloads).
- Mutation results (success/conflict + created IDs).
- Runtime nondeterminism events (time + random values), when tracing is enabled.
- Scheduler decisions (phase ordering) for interleaving reconstruction.
- Optional **external trace events** emitted by core middleware (e.g., auth decisions, route
  inputs), so model checker tracing can be generalized beyond workflows without fragment-specific
  APIs.

Design note:

- The trace sink is a **core internal hook** that middleware can emit to; fragments should not
  expose this surface in their public API.
- The trace sink must be integrated into the core route/middleware execution pipeline so auth hooks
  and request validation can emit trace events automatically when tracing is enabled.

This trace is used for coverage accounting and debugging but does not replace DB state hashing.

### 9.3 Path Hashing (trace-aware)

Add a trace-aware hashing option:

- `traceHasher`: hashes the normalized trace (or a prefix) to identify explored paths.
- Default behavior remains `stateHash + schedule prefix`.
- Allow combining `stateHash` and `traceHash` for stronger path uniqueness.

Model checker step model:

- Each transaction has at most two steps: **retrieve** then **mutate**.
- Interleavings are sequences of `(txId, phase)` where `phase ∈ {retrieve, mutate}`.
- A schedule is valid if each transaction’s retrieve precedes its mutate.

## 10) Conformance & Testing

- Create a shared adapter conformance suite using existing adapter tests.
- Add tests for:
  - `.check()` conflicts
  - cursor pagination
  - joins (one/many/nested)
  - instrumentation hook ordering + injection
  - deterministic clock/ID generation

---

## Default Decisions (model checker)

- **Path hashing** defaults to full state hashing (rows + versions) for correctness; users can
  override with a custom hash function for performance.
- **Infinite mode** defaults to bounded LRU history; users can opt into unbounded history
  explicitly.
- **Trace recording** is opt-in by default; when enabled, trace hashes may be combined with state
  hashes for path tracking.
