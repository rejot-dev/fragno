# CLAUDE.md

## Project Overview

Fragno is a framework-agnostic, type-safe full-stack TypeScript framework that enables building
portable full-stack libraries called "fragments". It follows a core + adapters pattern where
@fragno-dev/core provides the framework-agnostic implementation and specific adapters provide
integration with React, Vue, Node.js, and various meta-frameworks.

## Architecture

- **Fragments**: Full-stack libraries that work across different frameworks
- **Code Splitting**: Automatic client/server code separation via @fragno-dev/unplugin-fragno
- **Type Safety**: End-to-end TypeScript types from server to client
- **State Management**: Built on nanostores for reactive state management

## Common Commands

### Root-level commands

- `bun run build` - Build all packages
- `bun run types:check` - TypeScript type checking across all packages
- `bunx vitest run` / `bunx vitest run packages/fragno` - Run tests (for a specific package)

### Package-specific commands

In each package directory (`packages/fragno/`, `packages/chatno/`, etc.):

- `bun run types:check` - TypeScript type checking

Note that filtering for a specific file to type check DOES NOT work. You can pipe to `grep` / `rg`
to filter.

## Package Structure

- `packages/fragno/` - Core framework (@fragno-dev/core)
- `packages/fragno-node/` - Node.js adapter
- `packages/unplugin-fragno/` - Build-time code splitting plugin
- `packages/chatno/` - Example fragment with OpenAI integration
- `packages/example-fragment/` - Minimal fragment example
- `examples/` - Framework integration examples (React Router, Next.js, Nuxt, Astro)

## Development Practices

- Use `import type` for type imports
- NEVER use `any` unless absolutely necessary, default to `unknown` instead
- Prefer named exports over default exports
- Use kebab-case for file names, PascalCase for components
- Tests use vitest framework
- Pre-commit hooks run ESLint, Prettier, and type checking
- Bun >= 1.2.20 required
- Use `bun install --linker=isolated` for installations
- **Important**: When adding new exports to a package.json file, you must also update the
  corresponding tsdown.config.ts file in the same directory to include the new entry points
