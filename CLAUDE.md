# CLAUDE.md

## Project Overview

Fragno is a framework-agnostic, type-safe full-stack TypeScript framework that enables building
portable full-stack libraries called "fragments". It follows a core + adapters pattern where
`@fragno-dev/core` provides the framework-agnostic implementation and specific adapters provide
integration with React, Vue, Node.js, and various meta-frameworks.

## Architecture

- **Fragments**: Full-stack libraries that work across different frameworks
- **Code Splitting**: Automatic client/server code separation via @fragno-dev/unplugin-fragno
- **Type Safety**: End-to-end TypeScript types from server to client
- **State Management**: Built on nanostores for reactive state management
- **Two Audiences**: Library Authors build fragments; Users integrate them into their apps
- **Fragment Workflow**: Authors define routes + client hooks → Users mount routes + use hooks
- **Database Layer**: Optional @fragno-dev/db for fragments needing persistent storage
  (Kysely/Drizzle adapters)

## Common Commands

These can be run in either the root or in specific package directories. In the root `turbo` is used
as a monorepo manager.

- `pnpm run build` - Build all packages
- `pnpm run types:check` - TypeScript type checking across all packages
- `pnpm exec vitest run`

## Tools

- pnpm + Node
- Turbo(repo) for monorepo management
- TSDown for building packages
- Vitest
- Lefthook for pre-commit hooks
- Prettier
- ESLint

## Development Practices

### Core

- [IMPORTANT]: When adding new exports to a package.json file, you must also update the
  corresponding tsdown.config.ts file in the same directory to include the new entry points

### TypeScript + Style

- Use strict TypeScript configuration
- Do NOT use `any` unless absolutely necessary
- Use proper JSDoc comments for public APIs
- Prefer to destruct objects in things like for-loops.
- In Typescript, never use Array<T>, always use T[]
- Use Javascript private (#) for private members, NEVER use `private` in Typescript.
- Always use `import type` and indicate `type` as needed
- Always use curly braces, even for single-line blocks. You may add parentheses if you find a block
  without them.
- Avoid:
  - Enums
  - Constructor parameter members
  - TypeScript constructs that don't work with type stripping
- When using unsafe casts (`x as Y`), always add a comment explaining why it's safe. Prefer not to
  use them.

### Testing

- When testing _types_, do NOT use `.toMatchTypeOf(..)`, it's deprecated. Use either
  toMatchObjectType or toExtend instead:
  - Use toMatchObjectType to perform a strict check on a subset of your type's keys
  - Use toExtend to check if your type extends the expected type

### File Naming

- Use kebab-case for file names
- Use PascalCase for component/class files
- Use lowercase for utility and helper files
- Internal files go in `internal/` subdirectories
- Tests are colocated, e.g. `route.ts` -> `route.test.ts`

### Import/Export Patterns

- Use named exports over default exports
- Keep internal imports separate from public API imports
- Use relative imports within packages, package imports across packages

## Package Structure

### Core Packages

- `packages/fragno/` - Core framework (@fragno-dev/core) - Fragment definition, routing, client
  builders
- `packages/fragno-node/` - Node.js adapter for Express/HTTP servers (@fragno-dev/node)
- `packages/unplugin-fragno/` - Build-time code splitting plugin (@fragno-dev/unplugin-fragno)
- `packages/fragno-db/` - Type-safe ORM for fragments (@fragno-dev/db)
  - Schema definition with versioning and migrations
  - Kysely and Drizzle adapters
  - Goal is to let Fragment authors define a (simple) data model to store data in the user's db
- `packages/create/` - Library to create Fragno fragments

### Tooling

- `packages/create-cli/` - CLI to create Fragno fragments (`npm create fragno`), uses
  `packages/create`

### Example Fragments

- `example-fragments/chatno/` - OpenAI integration fragment example
- `example-fragments/example-fragment/` - Minimal fragment template

### Documentation & Examples

- `apps/docs/` - Documentation site (Next.js + Fumadocs)
  - `content/docs/fragno/for-library-authors/` - Building fragments
  - `content/docs/fragno/for-users/` - Integrating fragments
- `examples-apps/` - Framework integration examples (Next.js, Nuxt, React Router, Astro, SvelteKit,
  Vue SPA)
