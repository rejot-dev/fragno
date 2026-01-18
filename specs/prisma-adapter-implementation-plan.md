# Fragno Prisma Support — Implementation Plan (Draft)

This plan implements `specs/prisma-adapter-spec.md`.

## Phase 0 — Decisions locked

1. Default output filename: `fragno.prisma`.
2. SQLite profile: `PrismaAdapter` defaults to `sqliteProfile: "prisma"`.
3. SQLite IDs: Prisma schema uses `_internalId Int` on SQLite; `_internalId BigInt` on
   Postgres/MySQL.
4. SQLite BigInt safety: require safe int64 roundtrips; throw on unsafe JS `number` values. Document
   `better-sqlite3` setup (`db.defaultSafeIntegers(true)`).
5. DateTime defaults: emit Prisma `@default(now())` and decode SQLite `CURRENT_TIMESTAMP` strings as
   UTC.
6. Inverse relation naming: prefer matching `type: "many"` name, else source table `ormName`, else
   deterministic disambiguation.
7. Postgres JSON: emit `Json @db.Json` (match Fragno physical `json`).

## Phase 1 — Storage profile plumbing (SQLite)

Goal: make SQLite storage Prisma-native in a maintainable way driven by `DriverConfig`. Status:
complete (sqliteProfile added; type mapping, migration generation, and runtime serializer updated).

1. Extend `packages/fragno-db/src/adapters/generic-sql/driver-config.ts` with a backwards-compatible
   storage profile surface:
   - `get sqliteProfile(): "fragno" | "prisma"` (default `"fragno"`) or equivalent.
2. Type mapping:
   - update `packages/fragno-db/src/schema/type-conversion/create-sql-type-mapper.ts` (or add a new
     factory) to construct the SQLite type mapper using `driverConfig` so `timestamp`/`date` and
     `bigint` can vary by profile.
3. Migration SQL generation:
   - thread `driverConfig` (or a derived `storageProfile`) into
     `packages/fragno-db/src/adapters/generic-sql/migration/sql-generator.ts` and
     `packages/fragno-db/src/adapters/generic-sql/migration/dialect/sqlite.ts`
   - keep using `CURRENT_TIMESTAMP` for `dbSpecial: "now"` (matches current codebase and Prisma
     migrations); ensure runtime decoding treats it as UTC.
4. Runtime serialization:
   - update `packages/fragno-db/src/query/serialize/dialect/sqlite-serializer.ts` to serialize and
     deserialize `Date` and `bigint` per profile.
   - add strict safety checks to avoid silent precision loss when the driver returns large integers
     as JS `number` (throw if outside safe range).
   - add robust SQLite DateTime string parsing for `CURRENT_TIMESTAMP` format
     (`YYYY-MM-DD HH:MM:SS`) as UTC.

## Phase 2 — Prisma schema generator (`generate.ts`)

Status: complete for SQLite + PostgreSQL; MySQL support remains untested.

1. Add `packages/fragno-db/src/adapters/prisma/generate.ts`.
2. Implement deterministic output builder:
   - stable ordering (internal → namespaces → tables)
   - stable formatting (one blank line between models)
3. Implement naming helpers:
   - `sanitizeNamespace` for Prisma identifiers (reuse existing helper behavior)
   - `pascalCase` for model names
   - relation name generator (namespace + fromTable + referenceName + toTable)
4. Implement provider-specific Prisma scalar mapping:
   - SQLite first:
     - default to the `"prisma"` SQLite profile mapping (`DateTime`, `BigInt`)
     - support opt-in `"fragno"` legacy mapping (`Int` epoch ms, `Bytes` bigint blob) if kept
   - PostgreSQL (incl. PGLite) next:
     - ensure `date` uses `@db.Date`
     - ensure `json` uses `@db.Json` to match Fragno’s physical `json` type
   - MySQL last (tests optional)
5. Implement column emission:
   - `id String @unique @default(cuid())` (+ `@db.VarChar(30)` where supported)
   - SQLite: `_internalId Int @id @default(autoincrement())`
   - Postgres/MySQL: `_internalId BigInt @id @default(autoincrement())`
   - `_version Int @default(0)`
   - nullability for scalar FK fields and relation fields
6. Implement default emission rules:
   - static defaults via `@default(<literal>)`
   - `dbSpecial: now`:
     - DateTime: `@default(now())`
     - legacy SQLite `"fragno"` profile `Int` timestamps (if supported):
       `@default(dbgenerated(...))`
7. Implement indexes and unique constraints:
   - `@@index` / `@@unique` with `map` naming matching Drizzle generation
8. Implement relations:
   - emit `@relation("<relName>", fields:, references:, map:)` for `type: "one"`
   - generate inverse list fields (prefer matching `many` name; else `fromTable.ormName`)
   - handle self-relations and multiple relations between the same models

## Phase 3 — Prisma adapter (`prisma-adapter.ts`)

Status: complete.

1. Add `packages/fragno-db/src/adapters/prisma/prisma-adapter.ts`.
2. Extend `GenericSQLAdapter` and implement:
   - SQLite profile defaults (Prisma adapter forces `"prisma"` unless overridden)
   - `createTableNameMapper(namespace)` (match Drizzle behavior)
   - `createSchemaGenerator(fragments, options)` returning `{ schema, path }`
3. Ensure internal schema inclusion is handled by the generation engine (same as Drizzle).

## Phase 4 — Package exports & build config

Status: complete.

1. Add exports to `packages/fragno-db/package.json`:
   - `./adapters/prisma`
   - optionally `./adapters/prisma/generate`
2. Update `packages/fragno-db/tsdown.config.ts` to include the new entry points.

## Phase 5 — Tests

Status: complete for required coverage (SQLite + PGLite adapter tests include DateTime/JSON/BigInt
roundtrips, SQLite unsafe-number BigInt safety checks, and safe-integers BigInt roundtrips; MySQL
tests still optional).

1. Add snapshot tests similar to Drizzle:
   - `packages/fragno-db/src/adapters/prisma/generate.test.ts`
2. Test matrix:
   - SQLite: required
   - PostgreSQL: required
   - MySQL: generation supported; tests optional
3. Include targeted cases:
   - internal schema models
   - multi-fragment composition + stable ordering (internal → namespaces → models)
   - SQLite Prisma schema:
     - `_internalId Int @id @default(autoincrement())`
     - FK scalar fields are `Int`
     - `timestamp`/`date` are `DateTime` and `defaultTo(now)` becomes `@default(now())`
     - regular `bigint` is `BigInt`
   - PostgreSQL Prisma schema:
     - `json` is `Json @db.Json`
     - `date` is `DateTime @db.Date`
   - indexes / uniques (`@@index` / `@@unique` + `map:` naming)
   - relations:
     - one relation + generated inverse
     - explicit `type: "many"` name is used for inverse when it matches
     - fallback inverse name uses source table `ormName`
     - multiple relations between same models are disambiguated deterministically
     - self-reference
   - SQLite runtime profile `"prisma"`:
     - decoding `CURRENT_TIMESTAMP` strings as UTC (`YYYY-MM-DD HH:MM:SS`)
     - BigInt safety: throw if driver returns an unsafe JS `number` for a BigInt column
     - BigInt success path when driver returns `bigint` (e.g. `sqlocal`; `better-sqlite3` with safe
       integers enabled)
   - Prisma adapter runtime checks: count operations and cursor `hasNextPage` for SQLite/PGLite
   - Prisma adapter parity checks: SQLite `forSchema` multi-schema queries, `handlerTx` retry flow,
     and version conflict checks; PGLite version conflict checks

## Phase 6 — Documentation (recommended before release)

Status: complete.

1. Add Prisma adapter docs page (mirrors Drizzle/Kysely pages).
2. Update frameworks table and database fragments overview to include Prisma.
3. Add “Prisma schema folder” integration snippet and a single-file fallback.

## Validation (2026-01-18)

Status: complete.

- Prisma adapter SQLite + PGLite tests (vitest run)
- Prisma adapter SQLite parity tests (forSchema, handlerTx retry, version conflict)
- Prisma adapter PGLite version conflict test
- Repository lint (oxlint)
- Repository types check (turbo run types:check)
- Prisma docs updates (adapter page + overview + frameworks table)

Revalidated (2026-01-18): Prisma adapter SQLite/PGLite tests (including SQLite fragno-profile
generation), repository lint, repository types check.

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite adapter tests (joins + created-id cases),
repository lint, repository types check.

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite adapter tests, Prisma schema generation
tests, repository lint, repository types check.

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite tests
(`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint, repository types check.

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite tests (focused run:
`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint (`pnpm lint`), repository
types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite tests
(`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint (`pnpm lint`), repository
types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Added Prisma PGLite cursor pagination coverage; Prisma adapter
SQLite/PGLite tests (`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint
(`pnpm lint`), repository types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite tests
(`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint (`pnpm lint`), repository
types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite tests
(`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint (`pnpm lint`), repository
types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite tests
(`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint (`pnpm lint`), repository
types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite tests
(`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint (`pnpm lint`), repository
types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite tests
(`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint (`pnpm lint`), repository
types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Added SQLite CURRENT_TIMESTAMP UTC parsing test; Prisma adapter
SQLite/PGLite tests (`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint
(`pnpm lint`), repository types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite tests
(`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint (`pnpm lint`), repository
types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Added Prisma namespace/identifier generation tests; Prisma adapter
SQLite/PGLite tests (`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint
(`pnpm lint`), repository types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Added Prisma adapter external-id + same-transaction tests; Prisma adapter
SQLite/PGLite tests (`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint
(`pnpm lint`), repository types check (`pnpm turbo run types:check`).

Revalidated (2026-01-19): Prisma adapter SQLite/PGLite tests
(`pnpm -C packages/fragno-db test -- prisma-adapter`), repository lint (`pnpm lint`), repository
types check (`pnpm turbo run types:check`).
