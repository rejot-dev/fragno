# @fragno-dev/db

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
