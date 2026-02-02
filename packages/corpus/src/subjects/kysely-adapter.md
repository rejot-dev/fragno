# SQL Adapter (Kysely Dialects)

The SqlAdapter connects Fragno's database API to your SQL database via Kysely dialects.

```typescript @fragno-imports
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import {
  PGLiteDriverConfig,
  SQLocalDriverConfig,
  BetterSQLite3DriverConfig,
} from "@fragno-dev/db/drivers";
import { SqliteDialect, PostgresDialect, MysqlDialect } from "@fragno-dev/db/dialects";
import type { Dialect } from "@fragno-dev/db/sql-driver";
import SQLite from "better-sqlite3";
import { KyselyPGlite } from "kysely-pglite";
```

## Basic Setup

Create a SqlAdapter with your Kysely dialect and driver configuration.

```typescript @fragno-test:basic-setup types-only
const dialect = new SqliteDialect({
  database: new SQLite(":memory:"),
});

export const adapter = new SqlAdapter({
  dialect,
  driverConfig: new BetterSQLite3DriverConfig(),
});
```

The adapter requires:

- `dialect`: A Kysely dialect instance for your database
- `driverConfig`: A driver configuration matching your database type (`PGLiteDriverConfig`,
  `SQLocalDriverConfig`, or `BetterSQLite3DriverConfig`)

## First Party Kysely Dialects

Fragno re-exports the "first party" Kysely dialects for SQLite, PostgreSQL, and MySQL. This means
you can use these dialects without installing them yourself.

```typescript @fragno-test:first-party-kysely-dialects types-only
import { SqliteDialect, PostgresDialect, MysqlDialect } from "@fragno-dev/db/dialects";
```

## PGLite Example

```typescript @fragno-test:postgresql-example types-only
const { dialect } = await KyselyPGlite.create();

export const adapter = new SqlAdapter({
  dialect,
  driverConfig: new PGLiteDriverConfig(),
});
```
