# In-Memory Adapter + OCC Model Checker — Implementation Plan

## Adapter skeleton

- [x] Add `packages/fragno-db/src/adapters/in-memory/` module structure (Spec: §4.1)
- [x] Implement `InMemoryAdapter` class with `DatabaseAdapter` interface (Spec: §4.1)
- [x] Add `InMemoryAdapterOptions` with defaults (clock, id generators, btree order) (Spec: §4.1)
- [x] Add `idSeed` option and seeded `cuid2` default generator (Spec: §5.3)
- [x] Export adapter errors from the in-memory adapter module (Spec: §8)
- [x] Export adapter from `packages/fragno-db/src/mod.ts` (Spec: §4.1)
- [x] Add adapter type to `@fragno-dev/test` supported adapters (Spec: §9)

## Store + indexing

- [x] Implement in-memory store types (namespace -> table -> row map) (Spec: §§5.1, 6.1)
- [x] Add per-table internal ID counters (Spec: §§5.1, 6.1)
- [x] Implement sorted-array index with insert/remove/update/scan + binary search (Spec: §6.2)
- [x] Build indexes from schema (primary + declared indexes) (Spec: §6.2)
- [x] Enforce unique constraints at index layer (Spec: §6.2)

## Value handling

- [x] Implement value normalization using `SQLiteSerializer` for comparisons/index keys (Spec: §5.1)
- [x] Apply runtime defaults (`defaultTo$`) using injected clock (Spec: §5.2)
- [x] Apply db defaults (`defaultTo`, dbSpecial now) in memory (Spec: §5.2)
- [x] Implement reference resolution (external id -> internal id) (Spec: §5.4)

## Retrieval engine

- [x] Implement condition evaluation with SQLite-aligned semantics (Spec: §5.4)
- [x] Implement SQLite-like LIKE semantics for contains/starts/ends (Spec: §5.5)
- [x] Implement `find`, `findFirst`, `count` (Spec: §§5.4, 5.7)
- [x] Implement cursor pagination (`findWithCursor`, `after`, `before`) (Spec: §5.7)
- [x] Enforce `orderByIndex` only; throw on `orderBy` (Spec: §5.6)
- [x] Implement join execution from `CompiledJoin` (left joins, nested joins) (Spec: §5.8)

## Mutations + OCC

- [x] Implement create/update/delete/check operations (Spec: §7)
- [x] Increment `_version` on update; enforce `.check()` versions (Spec: §7)
- [x] Implement version conflict -> `{ success: false }` (Spec: §7)
- [x] Implement FK constraint enforcement (throws on violation) (Spec: §8)

## UOW instrumentation hooks

- [x] Extend `UnitOfWorkConfig` to include instrumentation hooks (Spec: §4.2)
- [x] Invoke hooks at phase boundaries in `executeRetrieve` / `executeMutations` (Spec: §4.2)
- [x] Implement conflict/error injection handling (Spec: §4.2)

## Model checker

- [x] Add model-checker utilities in `@fragno-dev/test` (Spec: §9)
- [x] Support schedules: exhaustive, random (seeded), infinite (Spec: §9)
- [x] Implement path recording + exhaustion detection (default full-state hash + bounded LRU) (Spec:
      §9, Default Decisions)
- [x] Provide raw-UOW transaction DSL helpers (Spec: §9)

## Conformance tests

- [x] Create adapter conformance suite based on existing adapter tests (Spec: §10)
- [x] Run suite for in-memory and one SQL adapter (Spec: §10)
- [x] Add targeted tests for hooks and fault injection (Spec: §10)
