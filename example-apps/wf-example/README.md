# Workflow Example App

This example app now uses a real Postgres instance for workflow storage.

## Environment

Create a `.env` file (or copy `.env.example`) and set the database URL:

```
WF_EXAMPLE_DATABASE_URL=postgres://postgres:postgres@localhost:5436/wilco
```

The app will also honor `DATABASE_URL` if `WF_EXAMPLE_DATABASE_URL` is not set.

## Running

```bash
pnpm --filter @fragno-example/wf-example dev
```

## Sharding

This example enables row-level sharding for the workflows fragment. On first load the UI blocks
until you pick a shard, then every API call is scoped to that shard.

- The shard choice is stored in `localStorage` (`wf-example:shard`) and mirrored in a cookie
  (`wf_example_shard`).
- Client requests include the `x-fragno-shard` header.
- The API route reads the header (or cookie) and wraps requests with
  `fragment.$internal.deps.shardContext.with(...)`.

To test with the CLI or curl, provide the header:

```bash
curl -H "x-fragno-shard: alpha" http://localhost:5173/api/workflows/approval-workflow/instances
```

Use the “Switch shard” button in the top nav (or clear `wf-example:shard`) to pick a new shard.

## Notes

- `drizzle.config.ts` reads the same env var for migrations and schema tooling.
- Make sure your Postgres instance is reachable on port 5436 (or update the env value).
