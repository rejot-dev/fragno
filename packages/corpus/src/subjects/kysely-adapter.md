# Kysely Adapter

The KyselyAdapter connects Fragno's database API to your Kysely database instance.

```typescript @fragno-imports
import { KyselyAdapter } from "@fragno-dev/db/adapters/kysely";
import { Kysely } from "kysely";
import type { Dialect } from "kysely";
```

## Basic Setup

Create a KyselyAdapter with your Kysely database instance and provider.

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

declare const dialect: Dialect;

export const db = new Kysely<MyDatabase>({
  dialect,
});

export const adapter = new KyselyAdapter({
  db,
  provider: "postgresql",
});
```

The adapter requires your Kysely instance and the database provider (`"postgresql"`, `"mysql"`, or
`"sqlite"`).

## Factory Function

For async database initialization, pass a factory function instead of a direct instance.

```typescript
async function createDatabase() {
  // Async initialization logic
  return new Kysely({ dialect: {} as Dialect });
}

export const adapter = new KyselyAdapter({
  db: createDatabase,
  provider: "postgresql",
});
```
