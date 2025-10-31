# Drizzle Adapter

The DrizzleAdapter connects Fragno's database API to your Drizzle ORM instance.

```typescript @fragno-imports
import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
```

## Basic Setup

Create a DrizzleAdapter with your Drizzle database instance and provider.

```typescript
interface MyDatabase {
  users: {
    id: string;
    email: string;
    name: string;
  };
  posts: {
    id: string;
    title: string;
    content: string;
    authorId: string;
  };
}

declare const db: NodePgDatabase<MyDatabase>;

export const adapter = new DrizzleAdapter({
  db,
  provider: "postgresql",
});
```

The adapter requires your Drizzle instance and the database provider (`"postgresql"`, `"mysql"`, or
`"sqlite"`).

## Factory Function

For async or sync database initialization, pass a factory function instead of a direct instance.

```typescript
import type { PgliteDatabase } from "drizzle-orm/pglite";

async function createDatabase(): Promise<PgliteDatabase> {
  // Async initialization logic
  const db = {} as PgliteDatabase;
  return db;
}

export const adapter = new DrizzleAdapter({
  db: createDatabase,
  provider: "postgresql",
});
```

Factory functions can also be synchronous for lazy initialization scenarios.
