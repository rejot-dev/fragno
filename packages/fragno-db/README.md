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
        const uow = db.createUnitOfWork("create-comment");
        const id = uow.create("comment", data);
        const { success } = await uow.executeMutations();
        if (!success) {
          throw new Error("Failed to create comment");
        }
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
  "routes": {
    "internal": "/_internal",
    "outbox": "/_internal/outbox",
    "outboxStream": "/_internal/outbox/stream",
    "outboxDurableStream": "/_internal/outbox/durable/schema/:schema",
    "outboxDurableStreamAll": "/_internal/outbox/durable/all",
    "outboxDurableState": "/_internal/outbox/durable/state"
  }
}
```

Notes:

- `schemas` excludes the internal Fragno schema.
- `fragments` only includes fragments that opted into outbox support via fragment options.
- `routes.outbox` is only present when at least one fragment has outbox enabled.

### Internal outbox read APIs

Outbox-enabled adapters expose five internal read APIs with different contracts:

- `GET /_internal/outbox` returns raw outbox entries and accepts `afterVersionstamp` and `limit`.
- `GET /_internal/outbox/stream` is an indefinite NDJSON stream used by Fragno consumers such as
  Lofi.
- `GET|HEAD /_internal/outbox/durable/schema/:schema` exposes a read-only Durable Streams projection
  for one outbox-enabled database namespace, or for a logical schema name when that name has one
  registered outbox namespace.
- `GET|HEAD /_internal/outbox/durable/all` exposes the complete adapter-wide raw outbox as a
  read-only Durable Stream.
- `GET|HEAD /_internal/outbox/durable/state` projects the adapter-wide outbox into Durable Streams
  State Protocol change events for consumers such as `@fragno-dev/tanstack-db`.

The raw Durable Streams projections use `application/json`; each `OutboxEntry` is one logical
message. Browser consumers can establish the wire contract with `parseOutboxStreamEntry` from
`@fragno-dev/db/outbox`. The serialized message contains `id`, `versionstamp`, `uowId`, `payload`,
optional `refMap`, and an ISO-8601 `createdAt` string. Outbox mutations identify their logical
`schemaName`, physical `schema`, and optional database `namespace`. Legacy custom-namespace entries
without `schemaName` remain readable through their namespace; ambiguous legacy null-namespace
entries are omitted rather than guessed into multiple streams. A transaction that mutates multiple
schemas remains one atomic message: every touched schema stream includes the complete transaction
entry. Integrations must therefore authorize all schemas in a shared transaction at the same
security boundary.

The state projection emits one standard change event per outbox mutation. Event `type` values encode
the logical schema name, physical namespace, and table without collisions; `key` is the external ID;
and headers contain the operation, unit-of-work transaction ID, and timestamp. Event values use a
versioned Fragno SuperJSON envelope so dates, bigints, binary values, and nested JSON preserve their
runtime representation. Creates carry complete visible non-ID values. Updates currently carry an
explicit Fragno patch value until every database adapter can return complete post-images in the
existing mutation round-trip. Reference placeholders are resolved and unresolved database
expressions are rejected before events leave the server.

Stream offsets are opaque 25-character lowercase hexadecimal positions derived from the global
outbox versionstamp sequence. Schema streams share this global watermark while filtering unrelated
transactions from response bodies. Clients must persist and replay returned `Stream-Next-Offset`
values without interpreting or constructing them.

Catch-up reads may omit `offset` or use `offset=-1` to start at the beginning. `offset=now` starts
at the current tail, and `live=long-poll` waits for future matching mutations. Catch-up and
successful non-`now` long-poll responses support ETags and `If-None-Match`. Browser preflight is
supported for conditional GETs, and protocol writes to an existing schema stream return
`405 Method Not Allowed` with `Allow: GET, HEAD, OPTIONS`.

The upstream TypeScript client is exercised against catch-up and long-poll over the production Node
HTTP route. The same route suite runs against the in-memory, SQLite/SQLocal, and PGlite adapters.
SSE is the only intentionally unsupported read mode: `live=sse` returns `400 Bad Request` rather
than silently changing transport. Finite stream closure is not applicable because database outbox
streams are always open and externally populated.

These endpoints expose internal mutation history and do not implement application-specific identity
or authorization. Production applications must protect `/_internal/outbox` and every descendant
route with their normal HTTP authentication and authorization layer and must use HTTPS. The
permissive CORS response is for protocol client interoperability; do not expose an unauthenticated
handler publicly.

A schema stream URL is durably identified by its registered logical schema name or database
namespace. Do not rename a schema or reuse its previous name/namespace for a different logical
stream while old outbox data remains. Removing a schema removes runtime access to its schema stream;
outbox streams otherwise remain open indefinitely and do not implement Durable Streams closure or
deletion.

Run the read-only protocol suite with
`pnpm exec turbo run conformance:durable-streams --filter=@fragno-dev/db`. When reviewing a local
Durable Streams checkout, set `DURABLE_STREAMS_REPO` so the freshness test also verifies the
reviewed `PROTOCOL.md` and upstream conformance source hashes:

```bash
DURABLE_STREAMS_REPO=/path/to/durable-streams \
  pnpm exec turbo run conformance:durable-streams:freshness --filter=@fragno-dev/db
```

Any upstream package, protocol, or conformance-source change fails the freshness check until the
snapshot,
[`DURABLE_STREAMS_READ_CONFORMANCE_MANIFEST.md`](DURABLE_STREAMS_READ_CONFORMANCE_MANIFEST.md), and
Fragno's applicable read-path tests are reviewed together. Turbo caches the normal
workspace-contained conformance suite, while the external-checkout freshness task intentionally
bypasses caching because files under `DURABLE_STREAMS_REPO` are outside Turbo's input graph. A
weekly workflow also compares the snapshot with npm's latest conformance release and upstream
`main`.

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
