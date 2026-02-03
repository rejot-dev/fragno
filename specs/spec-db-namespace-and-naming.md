# Fragno DB Namespaces + Naming Strategy — Spec

## 0. Open Questions

None.

## 1. Overview

This spec standardizes **namespaces** and **SQL naming** across Fragno DB while making schema names
mandatory and removing the legacy `name` vs `ormName` split.

Core changes:

- **Schema names are required** (breaking).
- **Namespace defaults to schema name** unless the fragment **user** explicitly overrides it at
  runtime (including setting it to `null`).
- **Naming is centralized** via a single naming strategy that covers tables, columns, indexes,
  foreign keys, and other named SQL artifacts.
- **Schema-based namespacing** (Postgres) is supported via the naming strategy (no schema name in
  driver config).
- **`name`/`ormName` distinction is removed**; the logical name is the single source of truth and
  physical names are derived via the naming strategy.

These changes apply to runtime query compilation, migrations, schema output (Drizzle/Prisma),
internal fragments, and CLI reporting.

## 2. Goals / Non-goals

### 2.1 Goals

1. Make schema names **non-optional** and first‑class.
2. Default namespace to schema name, with an explicit **runtime override** for users.
3. Centralize all SQL naming (tables/columns/constraints/etc.) into a single strategy used
   everywhere (runtime + migrations + schema generation).
4. Support schema‑based namespacing on databases that support it (Postgres) via a strategy, not
   driver config.
5. Remove `name` vs `ormName` duality to reduce confusion and mapping drift.

### 2.2 Non-goals

- Expanding the schema DSL beyond naming and namespace behavior.
- Changing query semantics or the UOW model.
- Adding new database providers beyond existing SQL adapters.

## 3. References

- Schema builder and core types: `packages/fragno-db/src/schema/create.ts`
- withDatabase & DB fragment builder: `packages/fragno-db/src/with-database.ts`,
  `packages/fragno-db/src/db-fragment-definition-builder.ts`
- Table name mapper + usage sites: `packages/fragno-db/src/adapters/shared/table-name-mapper.ts`,
  `packages/fragno-db/src/adapters/generic-sql/query/*`,
  `packages/fragno-db/src/adapters/generic-sql/migration/*`
- Schema outputs: `packages/fragno-db/src/schema-output/drizzle.ts`,
  `packages/fragno-db/src/schema-output/prisma.ts`
- Internal fragment and settings namespace: `packages/fragno-db/src/fragments/internal-fragment.ts`
- Migration generation engine: `packages/fragno-db/src/migration-engine/generation-engine.ts`
- Prisma naming constraints: `specs/spec-prisma-adapter.md`

## 4. Terminology

- **Schema name**: required identifier for a Fragno DB schema (author‑defined).
- **Namespace**: runtime grouping key for multi‑fragment table separation.
- **Logical name**: the name used in the schema DSL and query API.
- **Physical name**: the actual SQL identifier emitted to the database.
- **Naming strategy**: a centralized mapper that converts logical names to physical names for all
  SQL artifacts.

## 5. Current Behavior (Summary)

- `Schema` has no name; namespaces default to fragment names or `withDatabase(schema, namespace)`
  overrides.
- `Table` and `Column` store both `name` and `ormName`, but are typically identical.
- Mapping is fragmented: `TableNameMapper` handles tables only; columns and constraints are named
  ad‑hoc in multiple places.
- Schema outputs sanitize TypeScript identifiers but keep raw physical table names.

## 6. Schema Names + Namespace Resolution

### 6.1 Required Schema Names (Breaking)

`schema()` must require a name and persist it on the Schema object.

```ts
export interface Schema<TTables = Record<string, AnyTable>> {
  name: string; // required
  version: number;
  tables: TTables;
  operations: SchemaOperation[];
  clone: () => Schema<TTables>;
}

export function schema<const TTables extends Record<string, AnyTable>>(
  name: string,
  callback: (builder: SchemaBuilder<{}>) => SchemaBuilder<TTables>,
): Schema<TTables> {
  return callback(new SchemaBuilder(name)).build();
}
```

- All schema definitions must pass a name.
- Internal schema gets an explicit name (e.g. `fragno_internal`).

### 6.2 Namespace Resolution Rule

Namespace is resolved at **fragment instantiation time**:

1. If `options.databaseNamespace` is **provided** (not `undefined`), use its value **as‑is**.
   - `null` explicitly means “no namespace.”
2. Else use `schema.name`.

This removes definition‑time namespace overrides.

### 6.3 Runtime Override Surface

Add to `FragnoPublicConfigWithDatabase`:

```ts
export type FragnoPublicConfigWithDatabase = FragnoPublicConfig & {
  databaseAdapter: DatabaseAdapter<any>;
  durableHooks?: DurableHooksProcessingOptions;
  databaseNamespace?: string | null; // explicit override, null => no namespace
};
```

Implementation must check **property presence** (not just truthiness):

```ts
const hasOverride = options.databaseNamespace !== undefined;
const namespace = hasOverride ? options.databaseNamespace : schema.name;
```

### 6.4 Internal Fragment Exception

The internal fragment keeps **no namespace** for its tables regardless of schema name. It must set
`databaseNamespace: null` internally when instantiating the internal fragment.

## 7. Naming Strategy (Centralized Mapping)

### 7.1 New Naming Strategy Interface

Introduce a non‑optional strategy that covers all SQL nameable artifacts:

```ts
export interface SqlNamingStrategy {
  // Namespace strategy
  namespaceScope: "suffix" | "schema";
  namespaceToSchema: (namespace: string) => string; // used when namespaceScope === "schema"

  // Table + column mapping
  tableName: (logicalTable: string, namespace: string | null) => string;
  columnName: (logicalColumn: string, logicalTable: string) => string;

  // Index + constraint mapping
  indexName: (logicalIndex: string, logicalTable: string, namespace: string | null) => string;
  uniqueIndexName: (logicalIndex: string, logicalTable: string, namespace: string | null) => string;
  foreignKeyName: (params: {
    logicalTable: string;
    logicalReferencedTable: string;
    referenceName: string;
    namespace: string | null;
  }) => string;

  // Optional: allow other constraint names as needed later
}
```

### 7.2 Built‑in Strategies

- **`suffix` (default)**
  - Table names: `${logicalTable}_${namespace}` only when namespace is a non‑empty string; otherwise
    `logicalTable` (no dangling `_`).
  - Column names: `logicalColumn` (identity).
  - Index/FK names: consistent, collision‑safe, includes namespace when present.

- **`schema` (Postgres)**
  - `namespaceScope = "schema"`
  - `namespaceToSchema(namespace)`: derived from namespace (default: raw namespace; strategy may
    sanitize).
  - Table names: `logicalTable` (no suffix) under `db.withSchema(schema)`.

### 7.3 User Overrides

Users can **override** naming behavior by supplying a custom `SqlNamingStrategy` in adapter options.
This override must apply to:

- runtime SQL compilation
- migrations
- schema outputs (Drizzle/Prisma)
- CLI generation

### 7.4 Naming Resolver

Introduce a `NamingResolver` that binds a naming strategy to a schema + namespace, and provides
consistent lookups for runtime + tooling:

- `getTableName(logicalTable)`
- `getColumnName(logicalTable, logicalColumn)`
- `getIndexName(...)`
- `getForeignKeyName(...)`
- `getSchemaName(namespace)` (if schema‑scoped)
- `getTableNameMap()` and `getColumnNameMap(table)` for decoding

All naming logic must flow through this resolver.

## 8. Remove `name` vs `ormName`

### 8.1 Schema Types

- Remove `ormName` from `Table`, `Column`, `Relation`, and `Index`.
- `name` is the **logical** identifier everywhere.
- Physical names are only produced by `NamingResolver`.

### 8.2 Query + Migration Usage

All modules currently using `ormName` or `name` for SQL emission must switch to resolver methods.
Examples:

- `where-builder.fullSQLName` uses `resolver.getColumnName(table, column)`
- `select-builder.mapSelect` uses `resolver` to produce physical columns
- migrations use `resolver.getTableName` and `resolver.getIndexName`

## 9. Column Mapping

Column names must be resolved by the naming strategy. This affects:

- `encodeValues` / `decodeResult`
- `UnitOfWorkEncoder` / `UnitOfWorkDecoder`
- in‑memory adapter store keys

Logical column keys stay in user API; physical names are only used at SQL boundaries.

## 10. Schema Outputs (Drizzle / Prisma)

Schema generation must take a `SqlNamingStrategy` (directly or via the adapter) and use it for:

- physical table names
- physical column names
- index names and FK constraint names
- schema qualifiers (schema strategy)

### 10.1 Drizzle Output

- Use physical table names in `pgTable`/`mysqlTable`/`sqliteTable`.
- Column builders must use physical column names.
- Exported identifiers continue to be sanitized for TypeScript, but remain **logical**.
- Schema‑scoped strategy must emit schema‑qualified tables where supported.

### 10.2 Prisma Output

- Model names remain logical (sanitized for Prisma identifiers).
- `@@map` uses physical table names.
- Field `@map` uses physical column names when they differ.
- Constraint names (`@relation`, `@@index`, `@@unique`) use strategy output.

## 11. Migrations + Runtime SQL

### 11.1 Runtime

- SQL compilation uses `NamingResolver` everywhere.
- For schema strategy: Kysely `db.withSchema(schema)` is used for table references.

### 11.2 Migrations

- SQL generator uses `NamingResolver` for tables/columns/indexes/FKs.
- For schema strategy (Postgres): migrations must use `db.schema.withSchema(schema)` and emit
  `CREATE SCHEMA IF NOT EXISTS` once per namespace when generating SQL.

## 12. Breaking Changes

- `schema()` now requires a name argument.
- `withDatabase(schema, namespace?)` is removed; namespace is runtime only.
- `ormName` fields removed from schema types.
- Schema outputs and migrations will produce different physical names if a custom naming strategy is
  provided.
- `databaseNamespace` uses `null` (not `undefined`) for “no namespace.”

## 13. Validation & Testing

- Update existing unit tests and snapshots to reflect required schema names and naming strategy.
- Add tests for:
  - namespace defaulting to schema name
  - explicit `databaseNamespace: null`
  - custom naming strategy for columns and constraints
  - schema‑scoped strategy on Postgres
  - schema output parity (Drizzle/Prisma)
