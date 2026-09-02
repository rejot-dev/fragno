# Fragno

Fragno is a pre-1.0 meta-framework and end-to-end toolchain for users and agents building full-stack
libraries called **Fragments**. A Fragment can span frontend hooks, backend routes, and database
models.

Pre 1.0 means FULL BREAKING CHANGES, even in the data layer. We want to find
the optional API for our users. We're dogfooding everything in `apps/backoffice`.

## Users

- **You** are the agent building Fragno; **we** are the human contributors directing and reviewing
  the work.
- **Authors** build Fragments. Give them guardrails because they may not inspect generated or
  agent-written code.
- **Integrators** mount Fragments in applications. Assume they rely on public APIs, types, defaults,
  and documentation without reading implementation code.

## Coding style

- Functional core, imperative shell.
- Apply YAGNI.
- Make illegal states unrepresentable.
- No optional fields.
- Validate or cast the data at the edges, NEVER inside domain logic. We TRUST our data.
- Name domain operations.
- Single source of truth.
- Colocate tests with their source.
- Comments explain why, not what. Add comments for surprising behavior.
- Extract functions only when they own independent behavior; keep
  local behavior local.
- No barrel files.
- Top-level functions are defined with the `function` keyword. A file should have as few exports as possible. Prefer not testing over exporting.

Establish trust at boundaries: validate untrusted data, cast authoritative data, and keep
uninterpreted data opaque. Strengthen the source instead of compensating in every consumer.

Use canonical definitions and direct imports.

## Product principles

- **Scenario Testing** Test through real SQLite operations, routes, client-store updates, and final-state
  assertions. We test through "scenarios", specifically built test DSLs that allow us to test real
  user flows. Real end-to-end, but within a process.
- **Primitive-first.** Build reusable primitives, not application conveniences.

## Fragno's constraints:

We restrict authors so they can only do the right thing:

- No interactive transactions.
- No arbitrary joins.
- At most one retrieval round trip and one mutation round trip per HTTP endpoint.
- Cursor-based pagination only.
- Two-phase optimistic concurrency control.

## Architecture

Code is the source of truth for current APIs and capabilities.

- `@fragno-dev/core`: frontend/backend glue, HTTP routes, Nanostores-based stores, and React, Vue,
  Node.js, Next, and Nuxt adapters.
- `@fragno-dev/unplugin-fragno`: automatic client/server code splitting.
- `@fragno-dev/db`: optional data layer with schemas, constrained queries, migrations, two-phase
  OCC, and durable hooks. ORM adapters include Kysely, Drizzle, and Prisma; database adapters
  include SQLite, Postgres/PGLite, and MySQL.

## Fragment integration

Authors define routes, client hooks, schemas, and queries. Integrators mount the routes, migrate the
Fragment schema, and consume the hooks.

## Backoffice

Backoffice is the working name for the AI-native automation application in `apps/backoffice`. It is
a product combining all best aspects of Fragno. Backoffice tests whether Fragno's separate
primitives form one coherent system. Backoffice is our dogfooding proving ground for sessions, files, integrations, permissions,
workflows, generated interfaces, synchronization, and operations.

### Tests

In Backoffice, we test exclusively through scenario tests, unless specifically direct otherwise by me.

## Development

We use Turborepo + PNPM. `pnpm exec turbo build types:check test --output-logs=errors-only`

E.g.

- `pnpm exec turbo build --filter=@fragno-dev/db --output-logs=errors-only`
- `pnpm exec turbo test --filter=./packages/fragment-workflows --output-logs=errors-only`

Oxlint: `pnpm run lint:fix`
Oxfmt: `pnpm run format:changed`

DO NOT USE React Doctor, unless asked.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Other rules

- If you see changes unrelated to your work, prefer to keep them.
- If I ask a question, answer it instead of implementing.

## References

- **Models, schemas, transactions, public APIs, test seams, or non-obvious behavior:** read
  [`.agents/skills/self-documenting-code/SKILL.md`](.agents/skills/self-documenting-code/SKILL.md)
  and its relevant references.
