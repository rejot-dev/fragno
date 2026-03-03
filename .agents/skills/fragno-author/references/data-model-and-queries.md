---
title: Data Model and Queries
description: Designing fragment data models from routes, queries, and hooks
---

This guide is for fragment authors who are **designing the data model first**. The goal is to make
schema, routes, queries, and durable hooks line up from day one. Fragno does **not** support
arbitrary joins, so your data model must be explicit: every traversal you need must be modeled in
the schema.

## Design Order

1. Decide what must be persisted.
2. Decide what routes you will expose.
3. Sketch the query graph for each route.
4. Encode that graph in the schema (tables, relations, indexes).
5. Attach durable hooks for side effects.

## Core Rules (Apply These Always)

These are the rules that matter most for data modeling and query placement:

## 1. Model for joins, not just tables

Your schema is a **query graph**. Add relations for every traversal you will perform. If you need to
join on non-ID columns or want to avoid DB-enforced FKs, use join-only relations with
`foreignKey: false`. This is exactly how auth now models memberships, roles, and invitations:
explicit relations enable predictable joins without relying on user DB FK constraints.

## 2. Index every access path

If you use `whereIndex`, `orderByIndex`, or cursor pagination, the index must exist. Join-only
relations still require indexes; `foreignKey: false` only removes FK migrations, not performance
requirements.

## 3. Query everything upfront

Transactions are two-phase. Schedule **all reads** in `.retrieve(...)`, including actor, roles,
membership, and target resources. Filter and derive in memory if needed, then mutate. Never re-query
inside `.mutate(...)`. The auth changes on this branch move toward this pattern by joining through
session -> members -> roles -> organization in a single retrieve phase.

## 5. Mutate only after validation

Use `.check()` inside `mutate(...)` for invariants. If a rule depends on DB state, retrieve it in
the same transaction and validate before writing.

## 6. Hooks do async work

If you need side effects, trigger durable hooks inside the transaction and do the heavy/async work
in the hook handler, not in the route.

## Durable Hooks in Practice (Webhooks)

Webhook routes should be minimal:

1. Parse and validate the payload/signature outside the transaction.
2. In the transaction, do **only** `uow.triggerHook(...)` with the full payload and return.
3. If you need de-duplication, pass a deterministic id so the hook insert fails when it already
   exists.

The hook handler does the rest:

- Fetch any additional related data in its own `handlerTx()`.
- Call external APIs.
- Update status rows or write derived records.
- Rely on Fragno built-in retries/backoff to guarantee delivery.

This keeps the webhook route fast and safe, avoids partial failures, and guarantees that external
effects only happen after the DB commit.

## Where To Put Work

- Schema: tables, relations, indexes, and ownership boundaries. Design to match the joins you need.
- Routes: input parsing, session/context, error mapping, response serialization.
- Services: `serviceTx` with all reads, invariants, permissions, and writes in one transaction.
- Hooks: external API calls and retries.
- Serializers: DB row -> API shape, external IDs only.
