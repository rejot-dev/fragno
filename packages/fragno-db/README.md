# @fragno-dev/db

Optional, ORM-agnostic database layer for Fragno libraries.

Library authors define a type-safe schema; users plug in their existing Kysely or Drizzle setup so
data is written directly into their database.

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

export const commentSchema = schema((s) => {
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

Your users pass their own database adapter (Kysely or Drizzle) via `options`.

## Key features

- **Schema definition**: define tables, columns, indexes, and relations with a fluent, typed API.
- **Type-safe ORM**: full TypeScript inference for queries and results.
- **User-owned database**: your library never owns the database; users provide the adapter.
- **ORM agnostic**: works with Kysely or Drizzle (and more to come).
- **Namespaced tables**: avoids conflicts with user tables.

## ORM and database support

`@fragno-dev/db` works with:

- **Kysely**
- **Drizzle**

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
