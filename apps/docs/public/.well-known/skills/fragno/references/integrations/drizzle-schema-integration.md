# Drizzle Schema Integration

When the user uses Drizzle ORM, Fragno can generate a Drizzle schema file that integrates with the
user's existing Drizzle setup. This applies to any deployment target (Node.js, Cloudflare Workers,
etc.) — it is not specific to Durable Objects.

## Generate Fragno Schema as Drizzle

Use `--format drizzle` to output a Drizzle schema module:

```bash
npx @fragno-dev/cli db generate lib/my-fragment-server.ts --format drizzle -o db/fragno-schema.ts
```

This creates a file like `db/fragno-schema.ts` containing Drizzle table definitions and a named
schema export (e.g. `stripe_db_schema`, `forms_schema`).

Add a convenience script to `package.json`:

```jsonc
{
  "scripts": {
    "db:fragno:generate": "npx @fragno-dev/cli db generate lib/my-fragment-server.ts --format drizzle -o db/fragno-schema.ts",
  },
}
```

## Merge with Application Schema

Spread the Fragno schema into the app's combined schema export:

```ts
import { pgTable, text, serial } from "drizzle-orm/pg-core";
import { stripe_db_schema } from "./fragno-schema";

export const users = pgTable("users", {
  id: serial().primaryKey(),
  name: text().notNull(),
  email: text(),
});

export const schema = {
  users,
  ...stripe_db_schema,
};
```

This lets the user query Fragment tables through Drizzle's type-safe query builder alongside their
own tables.

## Drizzle Config for Dual Schemas

Both the app schema and the Fragno schema must be listed in `drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./db/app.schema.ts", "./db/fragno-schema.ts"],
  out: "./db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

Both files must be in the `schema` array so Drizzle Kit sees all tables when generating migrations.

## Schema Update Workflow

When a Fragment is updated and its schema changes:

1. Re-run `db:fragno:generate` to update the Fragno-Drizzle schema file.
2. Run `drizzle-kit generate` (or `drizzle-kit push`) to create/apply the migration.

## Multiple Fragments

Each Fragment produces its own named schema export. Spread them all:

```ts
import { stripe_db_schema } from "./fragno-stripe-schema";
import { forms_schema } from "./fragno-forms-schema";

export const schema = {
  users,
  ...stripe_db_schema,
  ...forms_schema,
};
```

Generate each separately:

```bash
npx @fragno-dev/cli db generate lib/stripe-server.ts --format drizzle -o db/fragno-stripe-schema.ts
npx @fragno-dev/cli db generate lib/forms-server.ts --format drizzle -o db/fragno-forms-schema.ts
```
