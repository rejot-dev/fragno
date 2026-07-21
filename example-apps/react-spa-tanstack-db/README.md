# react-spa-tanstack-db

Vite + React example that materializes Fragno's durable database outboxes into TanStack DB
collections with `@fragno-dev/tanstack-db-adapter`.

The example demonstrates:

- one Fragno outbox coordinator per fragment endpoint;
- multiple collections sharing the rating fragment coordinator;
- live React queries, including a join between comments and rating totals;
- browser SQLite persistence with OPFS and TanStack's multi-tab coordinator;
- direct server mutations followed by outbox ingestion.

The adapter is currently one-way. Existing rows remain available from local SQLite while offline,
but creating comments and ratings still requires the server; offline mutation queues and optimistic
client writes are intentionally not part of this example.

## Run

1. Install dependencies from the repository root:

```bash
pnpm install
```

2. Build and initialize the Fragno database example server. The database path is relative to the
   current directory, so initialize and run it from the example app directory:

```bash
pnpm exec turbo build --filter=./example-apps/fragno-db-usage-drizzle --output-logs=errors-only
cd example-apps/fragno-db-usage-drizzle
pnpm exec tsx ./src/init-tests.ts
node ./bin/run.js serve
```

The initialization command recreates `fragno-db-usage.pglite` and applies the generated Drizzle
schema, including Fragno's internal hooks and outbox tables.

3. In another terminal, start this SPA from the repository root:

```bash
pnpm --filter @fragno-example/react-spa-tanstack-db dev
```

Open the URL printed by Vite, usually `http://localhost:5173`.

## Configuration

The SPA defaults to `http://localhost:3000`. Override the server origin when starting Vite:

```bash
VITE_FRAGNO_SERVER_ORIGIN=http://localhost:8080 \
  pnpm --filter @fragno-example/react-spa-tanstack-db dev
```

The local database is stored as `fragno-tanstack-db.sqlite` in browser OPFS. Collection rows and
Fragno outbox checkpoints are persisted transactionally, so a reload hydrates local data before the
coordinators catch up with the server.
