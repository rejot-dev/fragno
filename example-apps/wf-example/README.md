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

## Notes

- `drizzle.config.ts` reads the same env var for migrations and schema tooling.
- Make sure your Postgres instance is reachable on port 5436 (or update the env value).
