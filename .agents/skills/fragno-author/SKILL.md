---
name: fragno-fragment-creation
description: Create or modify Fragno fragments (library-author workflow): scaffold a fragment package, define fragment config/schema, add dependencies/services, declare routes, build server instantiation, and export client builders plus per-framework client entrypoints. Use when asked to build a new fragment, add routes/hooks, or set up fragment packaging/code-splitting for authors.
---

# Fragno Fragment Creation

## Overview

Create or extend a Fragno fragment package with typed routes and client hooks for multiple
frameworks.

## Workflow (Library Author)

### Setup

- Prefer creating a new package via the create CLI. For scripted/non-interactive usage:

```sh
pnpm create fragno@latest --non-interactive --name my-fragment
```

This uses sensible defaults: tsdown build tool, database layer included, no agent docs, path set to
`./<name>`.

- OR: Install `@fragno-dev/core` manually. See "assets" below.

### Core building blocks

1. **Define fragment + config** in a definition module
   - `defineFragment<TConfig>("fragment-name").build()`
   - Export config type and any shared schemas.

2. **Optional dependencies / services**
   - Use `withDependencies(({ config }) => ({ ... }))` for server-only deps.
   - Dependencies are not bundled into the client.

3. **Define routes** in dedicated route modules
   - `defineRoutes(definition).create(({ defineRoute, config, deps, services }) => [ ... ])`
   - `defineRoute` options: `method`, `path`, `inputSchema`, `outputSchema`, `handler`,
     `errorCodes`, `queryParameters`.
   - Handler input context: `input.valid()` and request data helpers.
   - Handler output helpers: `json`, `jsonStream`, `empty`, `error`.

4. **Server-side fragment instance** (server entry module)
   - `instantiate(definition).withConfig(config).withRoutes([ ... ]).withOptions(options).build()`

5. **Client-side builder** (client builder module)
   - `createClientBuilder(definition, publicConfig, routes)`
   - Export hooks/composables: `createHook`, `createMutator`.

6. **Framework client entrypoints** (React/Vue/Svelte/Solid/Vanilla)
   - Create a file per framework: React, Vue, Svelte, Solid, Vanilla JS.
   - Each file wraps with the matching `useFragno` from `@fragno-dev/core/<framework>`.

## Docs lookup

- Search the docs index:
  - `curl -s "https://fragno.dev/api/search?query=defineRoutes"`
- Fetch docs as Markdown:
  - `curl -L "https://fragno.dev/docs/fragno/for-library-authors/getting-started" -H "accept: text/markdown"`

## References (library-author docs)

| Reference                          | What it is                                                 | When to read                                  | Full docs                                                                                |
| ---------------------------------- | ---------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Config, Dependencies, and Services | How config, deps, and services are structured and composed | When adding dependencies or exposing services | https://fragno.dev/docs/fragno/for-library-authors/features/dependencies-and-services    |
| Route Definitions                  | Route API, schemas, errors, query params, handlers         | When defining or updating routes              | https://fragno.dev/docs/fragno/for-library-authors/features/route-definition             |
| Client-side State Management       | Hooks, mutators, invalidation, custom stores, fetch config | When building client APIs or custom state     | https://fragno.dev/docs/fragno/for-library-authors/features/client-state-management      |
| Code Splitting                     | Unplugin usage, bundling, exports, peer deps               | Before publishing or changing build config    | https://fragno.dev/docs/fragno/for-library-authors/features/code-splitting               |
| Database Integration Overview      | When to add DB support and how the API is structured       | When the fragment needs persistence           | https://fragno.dev/docs/fragno/for-library-authors/database-integration/overview         |
| Defining Schemas                   | Schema DSL, indexes, relations, evolution rules            | When authoring or evolving a schema           | https://fragno.dev/docs/fragno/for-library-authors/database-integration/defining-schemas |
| Querying                           | Transaction builder patterns and query APIs                | When implementing DB reads/writes             | https://fragno.dev/docs/fragno/for-library-authors/database-integration/querying         |
| Durable Hooks                      | Outbox-style side effects and dispatchers                  | When you need reliable side effects           | https://fragno.dev/docs/fragno/for-library-authors/database-integration/durable-hooks    |
| Transactions                       | Handler/service transaction boundaries and `.check()`      | When composing multi-step DB operations       | https://fragno.dev/docs/fragno/for-library-authors/database-integration/transactions     |
| Database Testing                   | DB test harness and adapters                               | When testing database-backed fragments        | https://fragno.dev/docs/fragno/for-library-authors/database-integration/testing          |
| Testing                            | Core test utilities and `callRoute` behavior               | When writing unit/integration tests           | https://fragno.dev/docs/fragno/for-library-authors/testing                               |

## Assets (example code)

When creating a Fragment using the `create` command with database support, the following assets will
automatically be created.

| Asset                | What it is                                                              | Source                                                  |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `database-index.ts`  | Complete database-backed fragment: definition, services, routes, client | `packages/create/templates/optional/database/index.ts`  |
| `database-schema.ts` | Schema definition with tables, columns, indexes, and relations          | `packages/create/templates/optional/database/schema.ts` |
