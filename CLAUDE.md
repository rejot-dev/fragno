# CLAUDE.md

## Project Overview

Fragno is a TypeScript monorepo containing a type-safe web framework and related packages. It
follows a core + adapters pattern where generic implementations are framework-agnostic and
framework-specific adapters provide integration points.

## Monorepo Structure

- `packages/fragno/` - Core web framework with server-side API and client implementations
- `packages/chatno/` - Chat functionality package that integrates with Fragno
- `examples/react-router-example/` - React Router integration example
- `examples/*` - Various other integration examples
- `scripts/` - Build and workspace utility scripts

## Common Commands

### Installation

```bash
bun install --linker=isolated
```

### Building

```bash
bun run build              # Build all packages (in root directory)
```

### Package-specific commands

In each package directory (`packages/fragno/`, `packages/chatno/`):

- `bun run check` - TypeScript type checking

## Architecture Principles

### Core + Adapters Pattern

- Core implementations in `packages/fragno/src/` are generic and framework-agnostic
- Framework-specific adapters (React, etc.) are separate files/packages
- Keep core API surface minimal and composable

### File Organization

- `internal/` directories contain implementation details not exposed in public API
- `integrations/` directories contain framework-specific code
- Tests are co-located (e.g., `route.ts` → `route.test.ts`)
- Main exports go through `mod.ts` or `index.ts` files

## Key Components

## TypeScript Configuration

- Uses strict TypeScript with project references (`composite: true`)
- Configuration extends `tsconfig.base.json`
- Uses ESNext modules with bundler resolution
- Enables isolated declarations and strict type checking

## Development Practices

- Use `import type` for type imports
- Never use `any` unless absolutely necessary
- Prefer named exports over default exports
- Use kebab-case for file names, PascalCase for components
- Tests use vitest framework
- Pre-commit hooks run ESLint, Prettier, and type checking
