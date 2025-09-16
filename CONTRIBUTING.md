# Contributing

## Technologies

We use Bun for development, combined with Turborepo to manage the monorepo. Vitest for testing and
tsdown for individual package builds.

- Bun
- TypeScript
- Turborepo
- TSDown
- Vitest
- Lefthook (pre-commit hooks)

## Common Commands

### Root-level commands

- `bun run build` - Build all packages
- `bun run types:check` - TypeScript type checking across all packages
- `bunx vitest` - Run all tests
- `bunx vitest packages/fragno` - Run tests for a specific package

### Package-specific commands

In each package directory (`packages/fragno/`, `packages/chatno/`, etc.):

- `bun run types:check` - TypeScript type checking

Note that filtering for a specific file to type check DOES NOT work. You can pipe to `grep` / `rg`
to filter.

## Package Structure

- `packages/fragno/` - Core framework (@fragno-dev/core), also contains client adapter
  implementations for React, Vue, and vanilla JavaScript.
- `packages/fragno-node/` - Node.js adapter
- `packages/unplugin-fragno/` - Build-time code splitting plugin
- `packages/chatno/` - Example fragment with OpenAI integration
- `packages/example-fragment/` - Minimal fragment example
- `examples/` - Framework integration examples (React Router, Next.js, Nuxt, Astro, etc.)
