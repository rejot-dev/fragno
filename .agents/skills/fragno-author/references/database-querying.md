# Querying - distilled

Source: Fragno Docs — Querying

Full docs:
`curl -L "https://fragno.dev/docs/fragno/for-library-authors/database-integration/querying" -H "accept: text/markdown"`

## Preferred pattern

- Use `this.handlerTx()` inside route handlers to build and execute transactions.
- Use `async function (...) { ... }` so `this.handlerTx()` is available; avoid arrow functions.

## Finding records

- Queries must specify an index via `whereIndex(...)`.
- Use `find(...)` for arrays, `findFirst(...)` for single-row results.
- Support `select(...)`, `selectCount()`, `orderByIndex(...)`, and simple left joins.

## Pagination

- Use `findWithCursor(...)` for cursor-based pagination.
- Cursors can be encoded and passed back to fetch the next page.

## Mutations

- `create`, `update`, and `delete` via the mutation phase.
- Chain `.retrieve()` + `.mutate()` to read and then write within one transaction.

## Non-transactional access

- You can use `db` directly in dependencies for simple operations, but you lose atomic
  multi-operation transactions and durable hooks.
