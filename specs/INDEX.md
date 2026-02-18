# Specs - Index

Contains specifications and implementation plans.

Format:

- [TITLE](./<path>) — ELABORATE DESCRIPTION.

## Specifications

- [Fragno AI Fragment — Spec](./spec-ai-fragment.md) — AI fragment architecture and contract:
  thread/message/run models, NDJSON streaming, persistence guarantees, webhook handling, runner
  execution behavior, config surface, and client hooks.
- [Database Adapter Simplification — Spec](./spec-db-adapter-simplification.md) — Unify SQL runtime
  adapters, make schema output formats explicit, and replace ORM-specific adapters with a single SQL
  adapter plus explicit schema outputs.
- [Fragno DB Namespaces + Naming Strategy — Spec](./spec-db-namespace-and-naming.md) — Standardize
  schema names, namespaces, and SQL naming strategy across runtime, migrations, and schema outputs.
- [Durable Hooks Dispatchers — Spec](./spec-durable-hooks-dispatcher.md) — Process-at scheduling for
  durable hooks plus generic dispatchers (Node polling, Cloudflare DO alarms) that live in
  `@fragno-dev/db`.
- [In-Memory Adapter + OCC Model Checker — Spec](./spec-in-memory-adapter.md) — In-memory adapter
  design with optimistic concurrency control, SQLite-aligned semantics, storage/indexing, and model
  checker behavior.
- [Fragno DB Outbox — Spec](./spec-outbox.md) — Optional outbox with a global clock stored in
  internal settings, ordered UOW mutation capture, and programmatic retrieval.
- [Fragno Lofi Submit + Conflict Detection — Spec](./spec-lofi-submit.md) — Client submit endpoint,
  conflict detection via outbox mutation log, and optimistic overlay rebase semantics.
- [Fragno Prisma Support — Prisma Schema Generator Adapter — Spec](./spec-prisma-adapter.md) —
  Prisma integration spec covering schema generation rules, adapter responsibilities, naming
  conventions, provider-specific type mappings, migration expectations, and runtime serialization
  constraints.
- [Simple Auth Fragment Unification — Spec](./spec-simple-auth-fragment-unification.md) — Bring
  `packages/auth` to parity with the is3a-site implementation: schema, routes, client helpers,
  tests, build config, and docs.
- [Auth Organizations and Roles — Spec](./spec-auth-organizations.md) — Add organizations, members,
  roles, invitations, hooks, and conservative endpoints to the auth fragment.
- [Fragno Upload Fragment - Spec](./spec-upload-fragment.md) — Generic file upload + management
  fragment: storage adapters, key system, routes, DB schema, hooks, and client API.
- [Fragno Workflows Fragment — Spec](./spec-workflows-fragment.md) — End-to-end workflows fragment
  design: public API shape, database schema and indexes, lifecycle semantics (run/replay/wait/
  sleep), runner/tick behavior, durable hooks wiring, HTTP routes, and CLI/management surface.
- [Workflows Reliability Fixes — Spec](./spec-workflows-smoke-fixes.md) — Reliability fixes for the
  workflows fragment and durable hooks: batch create, task leasing, retries, timeouts, pagination,
  dispatcher clock skew, retention/GC, and Postgres resilience.
- [SQLite Stable DB Now for SQL Adapter — Spec](./spec-sqlite-stable-db-now.md) — Make SQLite dbNow
  stable across mutation statements by seeding a temp table and compiling SQLite mutations against
  it.

## Implementation Plans

- [AI Fragment — Implementation Plan](./impl-ai-fragment.md) — Execution tasks for the AI fragment
  spec: data model, streaming, hooks, webhook handling, and tests.
- [Database Adapter Simplification — Implementation Plan](./impl-db-adapter-simplification.md) —
  Execution tasks for the SQL adapter unification and schema output refactor.
- [Fragno DB Namespaces + Naming Strategy — Implementation Plan](./impl-db-namespace-and-naming.md)
  — Tasks to implement schema names, namespace defaults, naming strategy, and related updates/tests.
- [Durable Hooks Dispatchers — Implementation Plan](./impl-durable-hooks-dispatcher.md) —
  Implementation tasks for process-at durable hooks and generic dispatchers.
- [Fragno DB Outbox — Implementation Plan](./impl-outbox.md) — Implementation tasks for the outbox
  clock, schema, adapter integration, and tests.
- [Auth Organizations and Roles — Implementation Plan](./impl-auth-organizations.md) —
  Implementation tasks for auth organizations, members, roles, invitations, and hooks.
- [Fragno Runtime + Traceable Model Checker — Implementation Plan](./impl-runtime-and-trace.md) —
  Tasks to implement runtime injection and traceable model checker support.
- [Fragno Upload Fragment - Implementation Plan](./impl-upload-fragment.md) — Tasks to implement
  upload fragment, adapters, core streaming support, tests, docs, and examples.
- [Fragno Upload Fragment - File-on-Success Implementation Plan](./impl-upload-fragment-retry-semantics.md)
  — Tasks to implement file-on-success upload semantics, retries, and related updates.
- [Workflows Reliability Fixes — Implementation Plan](./impl-workflows-smoke-fixes.md) —
  Implementation tasks for the workflows reliability fixes spec.
