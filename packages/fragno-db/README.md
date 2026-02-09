# @fragno-dev/db

Optional, ORM-agnostic database layer for Fragno libraries.

Library authors define a type-safe schema; users plug in the SqlAdapter (configured with Kysely
dialects) so data is written directly into their database. Schema output can be generated for SQL
migrations, Drizzle, or Prisma workflows.

Full docs live at
[Database integration for library authors](https://fragno.dev/docs/fragno/for-library-authors/database-integration/overview).

## Who is this for?

- **Library authors** who want to ship a full-stack library that needs persistent storage, without
  owning the user's database.

Your library defines the schema and queries; your users provide the database adapter.

## Quick start

### 1. Install

```bash
npm install @fragno-dev/db @fragno-dev/core
# or
pnpm add @fragno-dev/db @fragno-dev/core
```

And make sure to install the CLI to perform migrations / schema generation:

```bash
npm install --save-dev @fragno-dev/cli
# or
pnpm add --dev @fragno-dev/cli
```

### 2. Define a schema

```ts
// schema.ts
import { schema, idColumn, column } from "@fragno-dev/db/schema";

export const commentSchema = schema("comment", (s) => {
  return s
    .addTable("comment", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("content", column("string"))
        .addColumn("userId", column("string"))
        .addColumn("postId", column("string"));
    })
    .addTable("user", (t) => {
      return t.addColumn("id", idColumn()).addColumn("name", column("string"));
    });
});
```

### 3. Attach it to your library

```ts
// index.ts
import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { commentSchema } from "./schema";

export interface CommentLibraryConfig {
  maxCommentsPerPost?: number;
}

const commentLibraryDef = defineFragment<CommentLibraryConfig>("comment-library")
  // --> use .extend to add the database layer <--
  .extend(withDatabase(commentSchema))
  .providesBaseService(({ db }) => {
    return {
      createComment: async (data: { content: string; userId: string; postId: string }) => {
        const id = await db.create("comment", data);
        return { id: id.toJSON(), ...data };
      },
    };
  })
  .build();

export function createCommentLibrary(
  config: CommentLibraryConfig = {},
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(commentLibraryDef)
    .withConfig(config)
    .withRoutes([])
    .withOptions(options)
    .build();
}
```

Your users pass a SqlAdapter via `options`. If `better-sqlite3` is installed, `databaseAdapter` is
optional and defaults to a local SQLite file per fragment in `FRAGNO_DATA_DIR` (default:
`~/.fragno`).

```ts
// User's application code
import { SqlAdapter } from "@fragno-dev/db";
import { PostgresDialect } from "kysely";
import { Pool } from "pg";

const commentLib = createCommentLibrary(
  { maxCommentsPerPost: 10 },
  {
    databaseAdapter: new SqlAdapter({
      dialect: new PostgresDialect({
        pool: new Pool({
          /* connection config */
        }),
      }),
    }),
  },
);
```

## Key features

- **Schema definition**: define tables, columns, indexes, and relations with a fluent, typed API.
- **Type-safe ORM**: full TypeScript inference for queries and results.
- **User-owned database**: your library never owns the database; users provide the adapter.
- **ORM agnostic**: SQL runtime with explicit schema output formats (SQL, Drizzle, Prisma).
- **Namespaced tables**: avoids conflicts with user tables.

## Internal registry + describe route

When multiple fragments share a database adapter, Fragno maintains an in-memory, adapter-scoped
registry of schemas and fragment mount routes. Each fragment exposes a lightweight internal describe
endpoint at `/_internal` (mounted under the fragment's mount route) that aggregates this registry.

Example response:

```json
{
  "fragments": [{ "name": "comment-library", "mountRoute": "/api/comment-library" }],
  "schemas": [
    { "name": "comment", "namespace": "comment", "version": 1, "tables": ["comment", "user"] }
  ],
  "routes": { "internal": "/_internal", "outbox": "/_internal/outbox" }
}
```

Notes:

- `schemas` excludes the internal Fragno schema.
- `fragments` only includes fragments that opted into outbox support via fragment options.
- `routes.outbox` is only present when at least one fragment has outbox enabled.

## ORM and database support

`@fragno-dev/db` works with Kysely dialects for runtime execution and supports SQL migrations plus
Drizzle or Prisma schema outputs.

Backed by Postgres and SQLite, including PGLite and Cloudflare Durable Objects.

## Docs and examples

- **Overview**:
  [Database integration for library authors](https://fragno.dev/docs/fragno/for-library-authors/database-integration/overview)
- **Schemas**:
  [Defining schemas](https://fragno.dev/docs/fragno/for-library-authors/database-integration/defining-schemas)
- **Querying**:
  [Querying API](https://fragno.dev/docs/fragno/for-library-authors/database-integration/querying)
- **Example library**:
  [`example-fragments/fragno-db-library`](https://github.com/rejot-dev/fragno/tree/main/example-fragments/fragno-db-library)

## Attribution

**Important:** A portion of this package's codebase is adopted from
[fumadb](https://github.com/fuma-nama/fumadb), which is licensed under the MIT License. We are
grateful to Fuma Nama (and contributors) for their excellent work on the original implementation.
