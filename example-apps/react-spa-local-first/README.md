NODE_OPTIONS=--conditions=development node --import tsx src/mod.ts serve# react-spa-local-first

Vite + React SPA demo that uses `@fragno-dev/lofi` to keep a local IndexedDB mirror of Fragno DB
outboxes. The UI lets you configure endpoints, pick tables, inspect local rows, and browse the local
`local_project_usage.project_usage` materialized view built from comment/rating mutations.

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

The Tables panel also includes a local schema:

- `local_project_usage.project_usage` combines comment mutations and rating total mutations into a
  read-only project/post summary view. This demonstrates Lofi local schemas and projections: the
  view is written transactionally while outbox entries are applied, but it is never submitted back
  to the server.

## SQLite replica

The **SQLite replica** tab mirrors the outbox of the first enabled endpoint into an OPFS SQLite
database with `@fragno-dev/lofi/sqlite`, including the `local_project_usage` projection. Pick a
table to query it, or write SQL; the result re-runs whenever any tab applies outbox entries. The
open replica is also available as `window.lofiSqliteReplica` in the browser console.

To check the multi-tab behaviour, open the tab in two browser tabs and create a comment (for example
with `example-apps/fragno-db-usage-drizzle/scripts/create-comment.sh`). Both tabs update; closing
the tab that writes hands writing to the other one within about a second.
