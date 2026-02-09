# Defining Schemas - distilled

Source: Fragno Docs — Defining Schemas

Full docs:
`curl -L "https://fragno.dev/docs/fragno/for-library-authors/database-integration/defining-schemas" -H "accept: text/markdown"`

## Schema basics

- Use `schema((s) => ...)` with `addTable`, `addColumn`, and `createIndex`.
- Every table needs exactly one `idColumn()` (user-facing CUID).
- The system adds hidden `_internalId` and `_version` columns.

## Column types

- Common: `string`, `integer`, `boolean`, `timestamp`, `json`, `bigint`, `decimal`, `date`,
  `binary`.
- Special: `idColumn()` and `referenceColumn()` for internal foreign keys.

## Defaults

- `defaultTo(...)` for database-side defaults.
- `defaultTo$(...)` for runtime-generated defaults (CUIDs, timestamps, custom logic).

## Indexes

- Indexes are required for most queries (`where` and `orderBy`).
- Multi-column indexes should list columns by selectivity (most selective first).
- Unique indexes are supported.

## Relations

- Use `addReference(...)` for internal relations between fragment tables.
- For external data (user-owned tables), use plain string columns, not `referenceColumn()`.

## Schema evolution

- Append-only log: each operation increments the schema version.
- Never change existing `addTable` calls; use `alterTable` for new columns/indexes.
- New columns must be nullable.
