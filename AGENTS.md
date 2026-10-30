# Backoffice

Backoffice is the AI-native automation product in `apps/backoffice`: people describe how their
business runs, and agents write it as workflows that run the same way every time, ask before they
act, and record every step. This repository exists to build Backoffice.

Fragno, the framework in `packages/`, is how we build it. Backoffice's features are built from
Fragments: full-stack libraries spanning frontend hooks, backend routes, and database models. Change
Fragno when Backoffice needs a primitive.

Pre 1.0 means FULL BREAKING CHANGES in Backoffice and Fragno, even in the data layer. We want to
find the optimal API for our users.

## Users

- **You** are the agent building Backoffice; **we** are the human contributors directing and
  reviewing the work.
- **Authors** build Fragments, mostly us for Backoffice. Give them guardrails because they may not
  inspect generated or agent-written code.
- **Integrators** mount Fragments in applications, Backoffice first. Assume they rely on public
  APIs, types, defaults, and documentation without reading implementation code.

## Backoffice (BO)

### Components

Add UI components to the private design system package (`packages-private/design-system`,
`@fragno-private/design-system`) when they are reusable or need to be designed in Storybook,
including landing page sections. Move an existing component there when Storybook work needs it.
Components that depend on Backoffice runtime data or routes stay in `apps/backoffice`.

### Tests

In Backoffice, we test exclusively through scenario tests, unless specifically direct otherwise by me.

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
- NO tautological tests

Establish trust at boundaries: validate untrusted data, cast authoritative data, and keep
uninterpreted data opaque. Strengthen the source instead of compensating in every consumer.

Use canonical definitions and direct imports.

## Product principles

- **Scenario Testing** Test through real SQLite operations, routes, client-store updates, and final-state
  assertions. We test through "scenarios" (setup, steps, assert), specifically built test DSLs that allow us to test real
  user flows. Real end-to-end, but within a process. If the tests are simple enough to not need steps, we should NOT have the test at all. If a test should normally be a unit test, DO NOT ADD IT at all.
- **Primitive-first.** Build reusable primitives, not application conveniences.

## Fragno

### Constraints

We restrict authors so they can only do the right thing:

- No interactive transactions.
- No arbitrary joins.
- At most one retrieval round trip and one mutation round trip per HTTP endpoint.
- Cursor-based pagination only.
- Two-phase optimistic concurrency control.

### Architecture

Code is the source of truth for current APIs and capabilities.

- `@fragno-dev/core`: frontend/backend glue, HTTP routes, Nanostores-based stores, and React, Vue,
  Node.js, Next, and Nuxt adapters.
- `@fragno-dev/unplugin-fragno`: automatic client/server code splitting.
- `@fragno-dev/db`: optional data layer with schemas, constrained queries, migrations, two-phase
  OCC, and durable hooks. ORM adapters include Kysely, Drizzle, and Prisma; database adapters
  include SQLite, Postgres/PGLite, and MySQL.

### Fragment integration

Authors define routes, client hooks, schemas, and queries. Integrators mount the routes, migrate the
Fragment schema, and consume the hooks.

## Development

We use Turborepo + PNPM. Verify your work with:

- `pnpm exec turbo build types:check --output-logs=errors-only`
- `pnpm test:changed`

`pnpm test:changed` runs the tests of affected packages, and within Backoffice only the tests your
changes reach. Run every test with `pnpm exec turbo test --output-logs=errors-only` when you need
the full suite, such as after changing repository-root files, which make no package affected.

`pnpm test:changed` skips Backoffice's slow Cloudflare tests (`*.cloudflare.test.ts`); CI runs them.

E.g.

- `pnpm exec turbo build --filter=@fragno-dev/db --output-logs=errors-only`
- `pnpm exec turbo test --filter=./packages/fragment-workflows --output-logs=errors-only`
- `pnpm exec turbo test:changed --filter=@fragno-apps/backoffice-rr --output-logs=errors-only`

When a Backoffice test reads a file without importing it (`fs`, `?raw`, `import.meta.glob`,
subprocesses), add the file to Backoffice's `forceRerunTriggers`; see
[Changed tests](CONTRIBUTING.md#changed-tests).

Oxlint: `pnpm run lint:fix`
Oxfmt: `pnpm run format:changed`

DO NOT USE React Doctor, unless asked.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Other rules

- If you see changes unrelated to your work, prefer to keep them.
- If I ask a question, answer it instead of implementing.
- Never start Docker. Run services such as MySQL natively, through Homebrew (`brew services`); when
  one is broken, tell me instead of working around it.

## References

- **Apps built on Backoffice:** [`apps/bookkeeping (BK)`](apps/bookkeeping) is the example app.
