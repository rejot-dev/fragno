# Database Integration Overview - distilled

Source: Fragno Docs — Database Integration Overview

Full docs:
`curl -L "https://fragno.dev/docs/fragno/for-library-authors/database-integration/overview" -H "accept: text/markdown"`

## What it is

- `@fragno-dev/db` is an optional database layer for fragments that need persistence.
- Users supply their own database adapter; you supply the schema and query logic.
- Works with Kysely or Drizzle; supports transactions, migrations, and durable hooks.

## Key ideas

- Extend a fragment with `withDatabase(schema)`.
- The fragment creation function must accept database options (adapter).
- DB operations use a builder pattern for safe, composable transactions.

## Service vs handler DB access

- Services define reusable operations with `this.serviceTx(schema)`.
- Handlers execute transactions with `this.handlerTx()`.
- Use `defineService()` so the `this` context is available and typed.

## Why the builder pattern

- Compose multiple service calls in one transaction.
- Batch reads/writes, reduce round-trips, and avoid interactive locks.
- Durable hooks attach side effects to commits.
