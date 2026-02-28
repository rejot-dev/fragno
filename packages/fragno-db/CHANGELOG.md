# @fragno-dev/db

## 0.4.0

### Minor Changes

- 8a96998: feat: allow altering existing columns to become nullable

### Patch Changes

- 3e2ff94: feat: register schemas via adapter registry and mount internal routes
- f34d7d7: fix: ensure cross-schema durable hook enqueuing works reliably
- 4d141f8: fix: remove development exports from published packages
- c8841b5: feat: add callServices helper with implicit request context
- ae54a60: fix: add browser-safe db entry and rewrite sync command imports for browser builds
- 7dd7055: feat: remove deps.db and add db-time helpers on builders
- e178bf4: fix: treat missing left-joined relations as null/[]
- d2f68ba: feat: add db now offsets and interval helpers
- d395ad2: fix: improve durable hook claiming and wake scheduling
- bfdd4b1: fix: skip better-sqlite3 fallback in Cloudflare workers
- 3ffa711: fix: align dev browser exports to avoid server entry in clients
- e559425: feat: add serviceCalls helper to preserve tuple inference for service deps
- 14e00b1: feat: expose hook event metadata in HookContext
- 95cdf95: feat: add browser-safe client exports entrypoint
- eabdb9c: feat(db): add in-memory outbox support
- 9eeba53: feat: add internal fragment describe metadata and adapter identity
- 49a9f4f: feat: add internal outbox mutation log and sync request tables
- dcba383: fix: write outbox mutation log rows during commits
- c895c07: feat(db): add internal sync submit endpoint and idempotency
- ed4b4a0: fix: add workerd/worker export conditions for server entry resolution
- ad2ef56: feat: move outbox opt-in to fragment options
- 0f9b7ef: refactor: replace linked fragments with internal routes
- 6d043ea: feat: add durable hooks runtime and dispatcher helpers
- fe55a13: feat(db): add read tracking hooks and plan mode support
- 01fc2cb: fix: scope db roundtrip guard to route handlers and enable by default in tests
- 00f2631: feat: allow triggerHook to accept explicit hook ids
- 0a6c8da: fix: stabilize sqlite recreate-table migrations
- 7a40517: fix: stabilize schema output ordering by schema name
- 91a2ac0: feat: add WorkflowStepTx API for step-scoped mutations
- 7bda0b2: feat(db): add sync command registry, registration, and sync entrypoint
- c115600: feat: widen external ids to 128 chars
- Updated dependencies [3e2ff94]
- Updated dependencies [f34d7d7]
- Updated dependencies [4d141f8]
- Updated dependencies [c8841b5]
- Updated dependencies [9eeba53]
- Updated dependencies [2ae432c]
- Updated dependencies [0f9b7ef]
- Updated dependencies [f4aedad]
- Updated dependencies [7bda0b2]
  - @fragno-dev/core@0.2.1

## 0.3.0

### Minor Changes

- 8e9b6cd: feat(db,cli): add SqlAdapter and explicit schema output formats

  BREAKING CHANGE: The database adapter API now requires SqlAdapter with explicit schema output
  formats.

### Patch Changes

- dbbbf60: fix: ensure unit-of-work after-phase hooks run on errors
- 3e07799: fix: allow durable hook processing to bypass wrapper adapters and widen drain helpers
- 20a98f8: feat: expose internal outbox route under /\_internal when outbox is enabled
- 1902f30: fix(db): normalize postgres timestamp decoding for timezone-less values.
- 15e3263: feat(db): require schema names and support namespace-aware SQL naming
- 208cb8e: feat: add runtime validation for table inserts
- 33f671b: fix(db): add dbNow value support, cursor pagination, and retry conflict handling
- fc803fc: fix(db): ensure Drizzle SQLite external ids are enforced as unique indexes.
- 0628c1f: fix(db): requeue durable hooks stuck in processing after a timeout
- 7e1eb47: feat(db): add processAt scheduling and reusable durable hooks dispatchers.
- 1dc4e7f: fix: disable handlerTx retries when no retrieve ops and reject explicit retry policies
- 3c9fbac: fix(db): align GenericSQL migration defaults and constraint names with Drizzle output.
- a5ead11: feat(db): add Prisma adapter and SQLite Prisma profile support.
- c4d4cc6: feat: default to sqlite adapter when databaseAdapter is omitted (better-sqlite3
  installed)
- d4baad3: fix: explicit databaseNamespace values are now used as-is without sanitization; default
  namespace (from schema.name) is still sanitized
- 548bf37: feat(db): expose handlerTx in durable hook context and deprecate direct query engines.
- 3041732: fix: run durable hooks off-request and relax pending task leases
- 7e179d1: feat(db): remove workflows dispatcher packages in favor of db dispatchers.
- 0013fa6: fix(db): store outbox versionstamps as strings.
- 69b9a79: fix: harden durable hook claiming and wake scheduling
- 5cef16e: feat(db,test): add SQL outbox support and adapter testing configuration.

## 0.2.2

### Patch Changes

- aca5990: breaking: remove executeUnitOfWork helper in favor of executeTx
- f150db9: feat: add `generateId(schema, tableName)` utility for pre-generating table IDs without
  creating records. Also available as `TypedUnitOfWork.generateId(tableName)` convenience method.
- 0b373fc: refactor: Rename `nonce` to `idempotencyKey` in public APIs

  Rename the `nonce` property to `idempotencyKey` in `HookContext` and `UnitOfWork` interfaces for
  better clarity and consistency. The database column name remains `nonce` for backward
  compatibility.

  **Breaking change**: Users accessing `this.nonce` in hook functions or `uow.nonce` in unit of work
  operations must update to `this.idempotencyKey` and `uow.idempotencyKey` respectively.

- fe27e33: feat: add new builder pattern for combining UOWs
- 9753f15: feat: Add unified transaction API with createServiceTx and executeTx

  Introduce a new unified transaction API that consolidates multiple transaction execution patterns
  into a single `executeTx` function with `TxResult` pattern. This provides better type safety,
  clearer composition patterns, and support for nested dependencies.

  New APIs:
  - `createServiceTx`: Create service-level transactions with dependency support
  - `executeTx`: Handler-level transaction execution with unified callback pattern
  - `TxResult` type: Branded type for transaction results with dependency tracking
  - `handlerTx` method: Added to fragment definitions for convenient access

  The old APIs (`executeTxCallbacks`, `executeTxWithDeps`, `executeTxArray`) are deprecated but
  remain available for backward compatibility.

## 0.2.1

### Patch Changes

- aecfa70: feat(db): allow user callbacks in uow options
- 3faac77: fix(db): child UOWs not reflecting parent's state after execution
- 01a9c6d: feat(db): add tx() API for simplified transaction handling

  Add new tx() method to both service and handler contexts that provides a simpler API for
  transaction handling with automatic retry support. Supports two syntaxes: array syntax for
  multiple service calls and callback syntax for direct UOW access. Also enhances restrict() to
  accept options for controlling readiness signaling.

- 5028ad3: fix(db): remove dependency on `node:inspect`
- 20d824a: fix(db): preserve internal IDs in child UOWs when using two-phase pattern with
  mutationPhase

## 0.2.0

### Minor Changes

- 4d897c9: Add durable hooks system for database fragments. Hooks are automatically persisted and
  retried on failure, allowing fragment authors to define side effects that execute after successful
  transaction commits.

### Patch Changes

- 8429960: Refactor DrizzleAdapter to extend GenericSQLAdapter
- a46b59c: Add Cloudflare Durable Objects SQL dialect support
- fcce048: feat: use "dry run" mode when searching for database schemas to be more lenient when
  instantiating a Fragment
- 147bdd6: Add migrate() helper and fragment type utilities
- f9ae2d3: fix: database namespace generation
- f3b7084: Simplify PreparedMigrations API to auto-execute migrations
- c3870ec: fix: use RETURNING clause for version conflict detection when affected rows unavailable

  Enable version conflict detection for drivers that support RETURNING but don't report affected
  rows (e.g., SQLocal). When version checking is enabled, UPDATE/DELETE queries now use RETURNING 1
  to detect if a row was modified, falling back to affected rows when available.

## 0.1.15

### Patch Changes

- d6a7ff5: feat: support standalone check() operation on UOWs
- e848208: feat: restrict Unit of Work in service contexts
- e9b2e7d: feat: add 'nonce' to Unit of Work for idempotent excecution
- 5e185bc: feat: add `withUnitOfWork` helper method to `deps` on Fragment instance
- ec622bc: fix: problem with serialization of cursor values
- 219ce35: fix: surface Database-driver level errors in executeMutation/executeRetrieve
- b34917f: feat: add `executeUnitOfWork` utility of retrying transactions, including support for
  retry policies.
- 7276378: feat: add providesPrivateService method to Fragment definition

  This allows the Fragment author to define private services that are only accessible within the
  Fragment's own code.

- 462004f: Add `hasNextPage` field to cursor pagination results. The `CursorResult` interface now
  includes an explicit `hasNextPage: boolean` field that accurately indicates whether more results
  are available.
- 5ea24d2: refactor: improve Fragment builder and instatiator
- f22c503: fix: make unit of work available in middleware
- 3474006: feat: add findFirst convenience method to UOWs

## 0.1.14

### Patch Changes

- acb0877: feat: add instantiateFragment helper function

## 0.1.13

### Patch Changes

- b54ff8b: Refactor cursor-based pagination API to make it more consistent and easier to use.

## 0.1.12

### Patch Changes

- 2900bfa: fix: improve typing on query results
- 059a249: Properly construct return type for `find` and `findFirst` with `select()`. The return
  type now correctly infers only the selected columns from the builder function, providing better
  type safety when using `.select()` to specify a subset of columns.
- f3f7bc2: feat: allow creating and referencing an object in a single unit of work
- fdb5aaf: Fix timestamp deserialization for PostgreSQL, MySQL, and CockroachDB. Previously,
  timestamp and date columns were returned as strings instead of JavaScript Date objects. Now they
  are properly converted to Date objects with full timezone support.

## 0.1.11

### Patch Changes

- 9a58d8c: fix: automatically create subqueries when filtering on FragnoReference objects

## 0.1.10

### Patch Changes

- ad3e63b: fix: workaround Drizzle limitation around relationships

## 0.1.9

### Patch Changes

- 8fcceb6: fix: Properly support inverse relations in Drizzle

## 0.1.8

### Patch Changes

- f3cdb1d: fix: properly generate subqueries in Postgres/Drizzle when inserting using external IDs

## 0.1.7

### Patch Changes

- e36dbcd: fix: allow async lazy initialization of `db` in adapters
- ab6c4bf: fix: make Fragment loading in the CLI more robust
- d1feecd: fix: allow lazy initialization of `db` in adapters

## 0.1.6

### Patch Changes

- 70bdcb2: feat: allow lazy initialization of `db` in adapters

## 0.1.5

### Patch Changes

- 8b2859c: fix(SQLite + Kysely): fix migrations hanging in some cases

## 0.1.4

### Patch Changes

- 5d56f48: fix(SQLite + Kysely): foreign key references now generate valid migrations
- fd3ddd2: fix(Drizzle): properly sanitize table references in foreign keys

## 0.1.3

### Patch Changes

- 0723f84: Fix transactions for Drizzle sync SQLite dialects

## 0.1.2

### Patch Changes

- e7122f2: DrizzleAdapter: now export Fragment schema version from generate schema file
- 921ef11: Schema definition: redesign the default value API to more clearly distinguish between
  database-level and runtime defaults
- be17727: Added support for generating migrations in multi-Fragment applications
- 8362d9a: Added support for using multiple database Fragments in a single application
- 8362d9a: DrizzleAdapter: support collecting schemas of multiple Fragments into a single Drizzle
  schema

## 0.1.1

### Patch Changes

- 4c1c806: Support tree shaking Fragno database dependencies from frontend bundle

## 0.1.0

### Minor Changes

- 2c583a9: Initial release of @fragno-dev/db
