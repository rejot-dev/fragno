# Database Adapter Simplification — Spec

## 0. Open Questions

None.

## 1. Overview

Fragno's SQL runtime adapter is already unified under `GenericSQLAdapter`. The current adapter
surface (KyselyAdapter, DrizzleAdapter, PrismaAdapter) only diverges in schema generation behavior
and a single SQLite storage default. This spec removes the ORM-specific adapters and replaces them
with a single, explicit SQL adapter plus explicit schema output formats.

Key changes:

- One SQL runtime adapter (`SqlAdapter`) for all SQL databases.
- Schema output format is explicit (`sql`, `drizzle`, `prisma`) rather than inferred from adapter
  type.
- Prisma integration becomes a schema output format + SQLite storage profile, not a separate
  adapter.
- CLI and docs are updated to match the new explicit format choice.

Breaking changes are acceptable and expected.

## 2. References

- Adapter interface: `packages/fragno-db/src/adapters/adapters.ts`
- Generic SQL adapter: `packages/fragno-db/src/adapters/generic-sql/generic-sql-adapter.ts`
- SQLite storage modes: `packages/fragno-db/src/adapters/generic-sql/sqlite-storage.ts`
- Drizzle schema generator: `packages/fragno-db/src/adapters/drizzle/generate.ts`
- Prisma schema generator: `packages/fragno-db/src/adapters/prisma/generate.ts`
- Generation engine: `packages/fragno-db/src/migration-engine/generation-engine.ts`
- CLI db commands: `apps/fragno-cli/src/commands/db/generate.ts`,
  `apps/fragno-cli/src/commands/db/migrate.ts`, `apps/fragno-cli/src/commands/db/info.ts`
- CLI reference docs: `apps/docs/content/docs/fragno/reference/cli.mdx`
- Database fragments overview:
  `apps/docs/content/docs/fragno/for-users/database-fragments/overview.mdx`
- Prisma adapter spec (schema output rules): `specs/spec-prisma-adapter.md`

## 3. Terminology

- **SQL adapter**: the runtime adapter that executes Fragno DB operations via Kysely dialects and
  Fragno's SQL driver.
- **Schema output format**: the generated artifact format from the CLI or generation engine: `sql`,
  `drizzle`, or `prisma`.
- **SQLite profile**: a named storage profile that selects SQLite storage semantics for timestamps
  and bigints.
- **Schema generation**: generation of Drizzle/Prisma schema artifacts (no DB connection required).
- **Migration generation**: generation of SQL migration files (requires DB connection + settings).

## 4. Goals / Non-goals

### 4.1 Goals

1. Remove ORM-specific adapters (Kysely/Drizzle/Prisma) and use a single SQL adapter for runtime.
2. Make schema output format explicit and decoupled from runtime adapter type.
3. Preserve existing Drizzle/Prisma generation behavior and defaults, but move them to explicit
   output formats.
4. Keep SQL migrations behavior unchanged for `sql` output.
5. Clarify Prisma integration by tying it to schema output + SQLite profile selection.
6. Update docs, examples, and tests to match the new API.

### 4.2 Non-goals

- Changing the query engine, schema DSL, or migration semantics.
- Adding new database backends or drivers.
- Changing the Fragno DB schema builder or UOW semantics.

## 5. Current State (Context)

- `KyselyAdapter`, `DrizzleAdapter`, and `PrismaAdapter` all extend `GenericSQLAdapter` and share
  the same adapter name/version, so they are already functionally identical for runtime queries.
- The only differences are:
  - schema generation (Drizzle/Prisma provide `createSchemaGenerator`, Kysely does not), and
  - Prisma's SQLite default storage mode (`sqliteStoragePrisma`).
- CLI `db generate` branches on `createSchemaGenerator` vs `prepareMigrations`, making output
  implicitly dependent on adapter choice.
- This implicit behavior is confusing, and it allows accidental mixing of adapters because the
  adapter identity is currently the same across all three wrappers.

## 6. Proposed Design

### 6.1 Single SQL Adapter

Introduce **one** SQL adapter for runtime usage: `SqlAdapter`.

- `SqlAdapter` replaces `GenericSQLAdapter` as the public runtime adapter.
- `KyselyAdapter`, `DrizzleAdapter`, and `PrismaAdapter` are removed.
- The adapter name symbol becomes `"sql"` and the adapter version becomes `1` to make the new
  surface explicit and avoid compatibility confusion.

### 6.2 SQLite Profiles

Introduce an explicit SQLite profile concept for clarity and Prisma integration.

- `SQLiteProfile = "default" | "prisma"`
- `default` maps to the existing `sqliteStorageDefault` behavior.
- `prisma` maps to the existing `sqliteStoragePrisma` behavior.

`SqlAdapter` accepts a `sqliteProfile` option and derives the internal `sqliteStorageMode` from it.
If `sqliteStorageMode` is provided directly, it is treated as an advanced override and must not be
combined with `sqliteProfile`.

Default: `sqliteProfile = "default"` (matching current runtime behavior).

### 6.3 Schema Output Formats

Schema output is an explicit format choice:

- `sql`: SQL **migration** generation (current behavior).
- `drizzle`: Drizzle **schema** generation (TypeScript schema module).
- `prisma`: Prisma **schema** generation (models-only schema file).

Drizzle and Prisma generation are moved out of adapters into explicit schema output modules.

### 6.4 Generation Engine

Replace the current implicit branching with explicit format selection.

- New type: `SchemaOutputFormat = "sql" | "drizzle" | "prisma"`.
- New engine API (name may change; see API section) accepts `format` explicitly.
- For `sql` (migration generation):
  - requires `prepareMigrations` and a healthy DB connection (unchanged behavior).
  - continues to include the internal settings table migration first.
- For `drizzle` / `prisma` (schema generation):
  - does not require a DB connection.
  - always includes internal schema first, then fragment schemas (same as current Drizzle/Prisma
    generation behavior).
  - rejects `fromVersion` / `toVersion` (explicit error).

### 6.5 CLI Behavior

`fragno-cli db generate` gains a `--format` option:

- `--format sql` (default) generates SQL **migrations** (unchanged).
- `--format drizzle` generates a Drizzle **schema** module.
- `--format prisma` generates a Prisma **schema** file (models-only).

`--from` / `--to` are **only valid for `sql` migration output** and will error for other formats.

`fragno-cli db migrate` remains SQL-only and requires adapters that support migrations.

`fragno-cli db info` should surface:

- database type (sqlite/postgresql/mysql) for SQL adapters,
- sqlite profile when applicable,
- migration support (based on `prepareMigrations`).

### 6.6 Module and Export Changes

Public exports change to reflect the simplified surface:

- Remove:
  - `@fragno-dev/db/adapters/kysely`
  - `@fragno-dev/db/adapters/drizzle`
  - `@fragno-dev/db/adapters/prisma`
  - `@fragno-dev/db/adapters/drizzle/generate`
  - `@fragno-dev/db/adapters/prisma/generate`
- Add:
  - `@fragno-dev/db/adapters/sql` (new public SQL adapter)
  - `@fragno-dev/db/schema-output/drizzle` (Drizzle generator)
  - `@fragno-dev/db/schema-output/prisma` (Prisma generator)

Internal module moves are allowed to keep implementation clean, but public paths above are the
stable surface.

### 6.7 Prisma Integration (Changed)

Prisma is no longer an adapter. Prisma integration is now:

1. `SqlAdapter` configured with `sqliteProfile: "prisma"` (for SQLite only).
2. `fragno-cli db generate --format prisma` to output `fragno.prisma`.

The Prisma schema generator behavior and storage-mode rules remain governed by
`specs/spec-prisma-adapter.md`. This spec only changes how the generator is wired and how SQLite
profile selection is expressed.

### 6.8 Breaking Changes

- ORM-specific adapters are removed.
- `DatabaseAdapter` no longer includes `createSchemaGenerator`.
- Schema output format is explicit and no longer inferred.
- Adapter name/version changes to `sql@1`.
- CLI usage changes (`--format` required for non-sql output).
- Documentation and examples are updated accordingly.

## 7. API and Type Definitions

### 7.1 SQL Adapter

```ts
import type { Dialect } from "@fragno-dev/db/sql-driver";
import type { DriverConfig } from "@fragno-dev/db/drivers";
import type { SQLiteStorageMode } from "@fragno-dev/db/adapters/sql";

export type SQLiteProfile = "default" | "prisma";

export const sqliteProfiles: Record<SQLiteProfile, SQLiteStorageMode> = {
  default: sqliteStorageDefault,
  prisma: sqliteStoragePrisma,
};

export type SqlAdapterOptions = {
  dialect: Dialect;
  driverConfig: DriverConfig;
  uowConfig?: UnitOfWorkConfig;
  sqliteProfile?: SQLiteProfile; // default: "default"
  sqliteStorageMode?: SQLiteStorageMode; // advanced override, mutually exclusive with sqliteProfile
};

export class SqlAdapter extends DatabaseAdapter<UnitOfWorkConfig> {
  readonly driverConfig: DriverConfig;
  readonly sqliteStorageMode?: SQLiteStorageMode;
}
```

### 7.2 Schema Output Formats

```ts
export type SchemaOutputFormat = "sql" | "drizzle" | "prisma";

export type GenerateSchemaOptions = {
  format?: SchemaOutputFormat; // default: "sql"
  path?: string;
  fromVersion?: number; // sql only
  toVersion?: number; // sql only
};

export type GenerationEngineResult = {
  schema: string;
  path: string;
  namespace: string;
};

export async function generateSchemaArtifacts(
  databases: FragnoDatabase[],
  options?: GenerateSchemaOptions,
): Promise<GenerationEngineResult[]>;
```

### 7.3 Schema Output Modules

```ts
// @fragno-dev/db/schema-output/drizzle
export function generateDrizzleSchema(
  fragments: { namespace: string; schema: AnySchema }[],
  provider: SupportedDatabase,
  options?: { idGeneratorImport?: { name: string; from: string } },
): string;

// @fragno-dev/db/schema-output/prisma
export function generatePrismaSchema(
  fragments: { namespace: string; schema: AnySchema }[],
  provider: SupportedDatabase,
  options?: { sqliteStorageMode?: SQLiteStorageMode },
): string;
```

## 8. Usage Examples

### 8.1 SQL migrations (default)

```ts
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { PostgresDialect } from "@fragno-dev/db/dialects";
import { NodePostgresDriverConfig } from "@fragno-dev/db/drivers";

const adapter = new SqlAdapter({
  dialect: new PostgresDialect({ pool }),
  driverConfig: new NodePostgresDriverConfig(),
});
```

```bash
npx fragno-cli db generate lib/fragment-server.ts
npx fragno-cli db migrate lib/fragment-server.ts
```

### 8.2 Drizzle schema output

```bash
npx fragno-cli db generate lib/fragment-server.ts --format drizzle -o schema/fragno-schema.ts
```

### 8.3 Prisma schema output (SQLite profile)

```ts
const adapter = new SqlAdapter({
  dialect: new SqliteDialect({ database }),
  driverConfig: new BetterSQLite3DriverConfig(),
  sqliteProfile: "prisma",
});
```

```bash
npx fragno-cli db generate lib/fragment-server.ts --format prisma -o prisma/schema/fragno.prisma
```

## 9. Testing & Validation

- Update adapter tests to target `SqlAdapter` for sqlite, pglite, postgres, mysql.
- Update generation engine tests to cover `format` selection and error handling.
- Update Drizzle/Prisma generator tests to use new module paths and to validate storage profile
  behavior for Prisma.
- Update CLI command tests (if present) or add minimal CLI integration checks for `--format`.
- Update docs/examples smoke checks in CI as applicable.
