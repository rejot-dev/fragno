# Fragno

This is the monorepo for Fragno, a meta framework that allows the user to built full-stack
libraries.

We're building an end-to-end toolchain for users and agents to build libraries that span the
frontend, backend, and database layers.

## Current status

The project is PRE 1.0. That means FULL BREAKING CHANGES, even in the data layer. We're hardcore
dogfooding the meta framework, as well as full-stack libraries built on top of it with the goal to
perfect the API surface.

### Glossary

- _you_: the agent reading this document, building Fragno
- _me/we/us_: the humans contributing to Fragno, or the full-stack libraries in this repo. The party
  talking to you as we build.
- _developers/users/authors_: our users. The developers using Fragno to build and ship full-stack
  libraries. We assume that they won't read much of the code produced whilst using Fragno, so we
  must provide them with proper guardrails.
- _end-users/integrators_: the users of our users, integrating full-stack libraries into their
  full-stack apps. These are still programmers (or vibe coders) and they do not read code at all.

- _Fragments_: a full-stack library ("Frag" from "Fragno").

## Philosophy

These foundations are built by me and you, all your code in the core components are carefully
reviewed, as well as in some of the more critical full-stack libraries.

We believe that users, and certainly end-users do NOT always write optional code. Specifically when
it comes to distributed systems, or around databases. Atomic transactions, round-trips, exactly once
execution. These are things that (end-)users do not think about enough. It's our goal to help users
and end-users do the right thing.

This also means we need to restrict the user: no interactive transactions, no arbitrary joins, a
single database round-trip per HTTP endpoint, support ONLY cursor-based pagination. Limitations make
programs great: faster and more fault tolerant.

This means designing libraries around these limitations. Data models have to be designed around the
fact that we use optimistic concurrency control, do not have arbitrary joins, and every HTTP
endpoint can only have a single round-trip for retrieval, and a single round-trip for mutation.

### Full-stack <> End-to-end

When we say full-stack, we really mean it. This means end-to-end type safety, and also end-to-end
testing. Libraries built with Fragno can define tests that use a real SQLite database, so actual SQL
operations are tested. Actual routes are being called, and even client-side reactive stores are
being updated and can also be asserted inside of these tests.

### Boil the ocean

This project is ambitious. Handling all layers of the stack is not easy.

When planning, do not be afraid to suggest seemingly insane solutions. For example, rewriting
esbuild to work entirely in JS without file system access. Seems insane, but it's absolutely doable
with modern tools.

### Only build the primitives

We should avoid feature creep, and assume our users can use their agents to build whatever they
need. This may seem to counter "boil the ocean", but it does not. We're focused on the primitives.

Primitives are NOT basic. This is why we built Fragno Workflows, a durable execution primitive.

Since Fragno is the first, and only, way of building full-stack libraries, primitives have shifted.
A "GitHub App Fragment" could never have been a primitive, every applications has to integrate this
manually into every layer. But now we are able to ship this as a primitive.

### Obvious solutions

We should avoid being clever and doing things because they seem smart. We want everything we build
to be so obvious it feels kind of stupid.

When one of us prompts you, never hesitate to push back and suggest ways we could make things more
obvious. Note that "simple" and "obvious" are not always aligned, sometimes the "obvious" solution
is more complex.

"Obvious" solutions are the defaults that agents would assume are the case.

## Architecture

Fragno's documentation is part of this repository, you may read it, but generally it makes more
sense to read the underlying code.

The `@fragno-dev/core` package contains the frontend and backend glue. This allows libraries to
define HTTP routes and create reactive data stores (using Nanostores). It also contains adapters for
integration with React, Vue, Node.js, and various full-stack frameworks like Next and Nuxt.

Automatic client/server code splitting happens in `@fragno-dev/unplugin-fragno`.

### Data layer

`@fragno-dev/db` is a key piece of this repository, but optional to the Fragment authors. Features:

- Schema definition
- Limited ORM for queries
- ORM adapters: Kysely, Drizzle, Prisma
- Database Adapters: SQLite, Postgres/PGLite, MySQL
- Transactions: two-phase OCC transactions
- Migrations
- Durable Hooks (outbox pattern): Trigger durable hooks when database operations are performed,
  allowing the user to take action after a successful commit.

## How end-users integrate Fragments

- Authors define routes, client hooks, database schema, and queries.
- End-users mount routes into their application, migrate their database with the Fragment's schema,
  and use the hooks on the frontend

## Developing

We use Turborepo + PNPM. `pnpm exec turbo build types:check test --output-logs=errors-only`

E.g.

- `pnpm exec turbo build --filter=@fragno-dev/db --output-logs=errors-only`
- `pnpm exec turbo test --filter=./packages/fragment-workflows --output-logs=errors-only`

Oxlint: `pnpm run lint:type-aware-fix`
Oxfmt: `pnpm run format:changed`

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Other rules

- If you see changes unrelated to your work, prefer to keep them.