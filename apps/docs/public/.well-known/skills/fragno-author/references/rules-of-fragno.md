# Rules of Fragno (DB fragments)

Source: `apps/docs/content/docs/fragno/for-library-authors/rules-of-fragno.mdx`

These rules apply when you use `@fragno-dev/db`.

## 1. One `handlerTx()` per route

Each route should execute a **single** `handlerTx()` call. If you need multiple operations, compose
them inside one transaction (or via `.withServiceCalls(...)`), instead of starting extra
`handlerTx()` calls.

Exception: it can be acceptable to run **two** `handlerTx()` calls when you deliberately split a
flow into **retrieve → async work → mutate**, so the async work happens outside the transaction.
Keep this rare and explicit.

`handlerTx()` is two-phase: **schedule all reads in one `.retrieve(...)`**, then **schedule all
writes in one `.mutate(...)`**, then `.execute()`.

If you need related data, use `.join(...)` and multiple `.find...` calls inside the same
`.retrieve(...)` instead of starting extra `handlerTx()` calls.

## 2. Webhook routes are thin; durable hooks do the work

Webhook routes should validate, **trigger a durable hook**, and return. Heavy or async work belongs
in a `defineHook(...)` implementation, where you can use `this.handlerTx()` and
`this.idempotencyKey`.

## 3. `idColumn()` is your app-facing ID

`idColumn()` is the primary identifier for your records. It **can** store upstream IDs, but it
doesn't have to — you can also let it auto-generate (CUID) values. Fragno automatically adds
`_internalId` and `_version` under the hood, so you do not need extra columns to mirror either.

References can point at `idColumn()` values. `referenceColumn()` accepts ID strings (or `FragnoId`
objects) and the query layer resolves them for you.
