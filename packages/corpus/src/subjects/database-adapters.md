# Database Adapters

Database adapters connect Fragno's database API to your existing SQL database. They allow fragments
to work with your application's database without dictating which ORM you use.

```typescript @fragno-imports
import type { DatabaseAdapter } from "@fragno-dev/db";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { SQLocalDriverConfig } from "@fragno-dev/db/drivers";
```

## What is a Database Adapter?

A database adapter is a bridge between Fragno's type-safe database API and your underlying ORM. It
translates Fragno's query operations into ORM-specific syntax.

```typescript @fragno-test:what-is-adapter types-only
// Adapters implement the DatabaseAdapter interface
declare const adapter: DatabaseAdapter;

// Fragments receive an adapter through their configuration
interface FragmentConfig {
  databaseAdapter: DatabaseAdapter;
}
```

When a fragment needs database access, users pass an adapter configured with their ORM instance.

## Supported Providers

The SqlAdapter supports three database providers:

- `"postgresql"` - PostgreSQL databases
- `"mysql"` - MySQL and MariaDB databases
- `"sqlite"` - SQLite databases

Choose the provider that matches your database type when creating an adapter.

## Factory Functions

Adapters can be created from factory functions instead of direct ORM instances. This is useful for
lazy initialization (in serverless environments).

```typescript @fragno-test:factory-functions types-only
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { SQLocalDriverConfig } from "@fragno-dev/db/drivers";

declare const dialect: any; // Your Kysely-compatible dialect

export const adapter = new SqlAdapter({
  dialect,
  driverConfig: new SQLocalDriverConfig(),
});
```

The adapter calls into the dialect when it needs a database connection.

## Shared Adapters

Multiple fragments can share the same adapter, meaning they all use your application's single
database connection.

```typescript @fragno-test:shared-adapters types-only
declare const adapter: DatabaseAdapter;

// All fragments use the same adapter
export interface Fragment1Config {
  databaseAdapter: typeof adapter;
}

export interface Fragment2Config {
  databaseAdapter: typeof adapter;
}
```

This ensures fragments integrate seamlessly with your existing database infrastructure.

## Cleanup

Adapters manage connection lifecycle automatically. Call `close()` when shutting down your
application to properly release database connections.

```typescript @fragno-test:cleanup types-only
declare const adapter: DatabaseAdapter;

export async function cleanup() {
  await adapter.close();
}
```
