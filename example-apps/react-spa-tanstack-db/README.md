# react-spa-tanstack-db

Proof of concept for `@fragno-dev/tanstack-db` with TanStack DB's official browser SQLite
persistence. Fragno Durable Streams remain the server-authoritative source; TanStack persists each
materialized collection to SQLite WASM backed by OPFS and resumes from persisted collection
checkpoints after reload.

## Run

Install dependencies from the repository root:

```bash
pnpm install
```

Initialize and build the existing Fragno database example server:

```bash
cd example-apps/fragno-db-usage-drizzle
pnpm exec tsx ./src/init-tests.ts
cd ../..
pnpm exec turbo build --filter=@fragno-dev/fragno-db-usage-drizzle --output-logs=errors-only
```

Then start the server:

```bash
cd example-apps/fragno-db-usage-drizzle
NODE_OPTIONS=--conditions=development node --import tsx src/mod.ts serve
```

In another terminal, start this SPA:

```bash
pnpm --filter @fragno-example/react-spa-tanstack-db dev
```

Open the Vite URL, usually `http://localhost:5173`. Add comments and ratings, then reload the page.
The collections hydrate from OPFS SQLite before the Durable Stream catches up from its persisted
offset.

Set `VITE_FRAGNO_SERVER_ORIGIN` when the server is not available at `http://localhost:3000`.

## What it demonstrates

- Adapter-wide `/_internal/outbox/durable/state` synchronization using the Durable Streams State
  Protocol
- Explicitly named typed comment and rating collections
- Server-driven writes without optimistic collection mutations
- TanStack `persistedCollectionOptions` around Fragno's custom sync implementation
- Per-collection stream offsets stored as transactional collection metadata
- Resume from the oldest persisted collection offset
- Multi-tab persistence coordination through `BrowserCollectionCoordinator`
- One shared cache version across all persisted collections

The browser persistence package uses SQLite WASM and OPFS, not direct IndexedDB. Run the example on
localhost or HTTPS so the required browser storage APIs are available.
