# Transactions - distilled

Source: Fragno Docs — Transactions

Full docs:
`curl -L "https://fragno.dev/docs/fragno/for-library-authors/database-integration/transactions" -H "accept: text/markdown"`

## Two-phase model

- Retrieval phase schedules reads.
- Mutation phase schedules writes.
- Handlers execute the transaction; services define reusable operations.

## Handler responsibilities

- Use `this.handlerTx()` to compose `.retrieve()`, `.mutate()`, and `.withServiceCalls()`.
- Call `.execute()` to run the transaction; retries happen on optimistic conflicts.

## Service responsibilities

- Use `this.serviceTx(schema)` to define a `TxResult` and return `.build()`.
- Use `defineService(...)` and `function` syntax to access `this.serviceTx`.

## Optimistic concurrency

- Use `.check()` with a `FragnoId` to ensure a row has not changed.
- `.check()` requires a `FragnoId` (not a string). Without `.check()`, updates are last-write-wins.

## Side effects

- Avoid external side effects in transactions; use Durable Hooks instead.

## Error handling

- Handlers catch errors from `.execute()` and decide how to respond.
- Services do not execute or handle errors.
