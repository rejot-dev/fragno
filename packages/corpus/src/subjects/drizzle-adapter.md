# SQL Adapter (Drizzle)

The SqlAdapter connects Fragno's database API to your SQL database when using Drizzle ORM.

```typescript @fragno-imports
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
```

```typescript
// Example: Instantiate SqlAdapter with a Drizzle database
const db: NodePgDatabase = /* your drizzle db instance */;
const adapter = new SqlAdapter(db);

// Use with Fragno
const fragno = createFragno({
  databaseAdapter: adapter,
  // ... other config
});
```

Use `fragno-cli db generate --format drizzle` to emit the Drizzle schema output.
