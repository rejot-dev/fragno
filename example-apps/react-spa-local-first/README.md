NODE_OPTIONS=--conditions=development node --import tsx src/mod.ts serve# react-spa-local-first

Vite + React SPA demo that uses `@fragno-dev/lofi` to keep a local IndexedDB mirror of Fragno DB
outboxes. The UI lets you configure endpoints, pick tables, and inspect local rows.

## Run

1. Install deps from repo root:

```bash
pnpm install
```

2. Start the example server (from `example-apps/fragno-db-usage-drizzle`). Use the development
   condition so workspace packages resolve to source:

```bash
NODE_OPTIONS=--conditions=development node --import tsx src/mod.ts serve
```

3. Start the SPA:

```bash
pnpm --filter @fragno-example/react-spa-local-first dev
```

Open the URL printed by Vite (usually `http://localhost:5173`).

## Configure endpoints

Use the Endpoints panel to add or edit base URLs. For each endpoint, pick a schema pack and table,
then the Rows panel will show local entries pulled from the outbox.
