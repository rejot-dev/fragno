# Database Adapters

Database adapters connect Fragno's database API to your existing ORM (Kysely or Drizzle). They allow
fragments to work with your application's database without dictating which ORM you use.

```typescript @fragno-imports
import type { DatabaseAdapter } from "@fragno-dev/db";
```

## What is a Database Adapter?

A database adapter is a bridge between Fragno's type-safe database API and your underlying ORM. It
translates Fragno's query operations into ORM-specific syntax.

```typescript @fragno-test:what-is-adapter
// Adapters implement the DatabaseAdapter interface
declare const adapter: DatabaseAdapter;

// Fragments receive an adapter through their configuration
interface FragmentConfig {
  databaseAdapter: DatabaseAdapter;
}
```

When a fragment needs database access, users pass an adapter configured with their ORM instance.

## Supported Providers

Both KyselyAdapter and DrizzleAdapter support three database providers:

- `"postgresql"` - PostgreSQL databases
- `"mysql"` - MySQL and MariaDB databases
- `"sqlite"` - SQLite databases

Choose the provider that matches your database type when creating an adapter.

## Shared Adapters

Multiple fragments can share the same adapter, meaning they all use your application's single
database connection.

```typescript @fragno-test:shared-adapters
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

```typescript @fragno-test:cleanup
declare const adapter: DatabaseAdapter;

export async function cleanup() {
  await adapter.close();
}
```
