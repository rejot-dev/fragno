# CLAUDE.md

## Project Overview

Fragno is a TypeScript monorepo containing a type-safe web framework and related packages. It
follows a core + adapters pattern where generic implementations are framework-agnostic and
framework-specific adapters provide integration points.

## Common Commands

### Package-specific commands

In each package directory (`packages/fragno/`, `packages/chatno/`, etc.):

- `bun run types:check` - TypeScript type checking

## Development Practices

- Use `import type` for type imports
- Never use `any` unless absolutely necessary
- Prefer named exports over default exports
- Use kebab-case for file names, PascalCase for components
- Tests use vitest framework
- Pre-commit hooks run ESLint, Prettier, and type checking
