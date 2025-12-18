# @fragno-dev/db

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
