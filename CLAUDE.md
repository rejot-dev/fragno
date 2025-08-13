# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project Overview

Fragno is a TypeScript monorepo containing a type-safe web framework and related packages. It
follows a core + adapters pattern where generic implementations are framework-agnostic and
framework-specific adapters provide integration points.

## Monorepo Structure

- `packages/fragno/` - Core web framework with server-side API and client implementations
- `packages/chatno/` - Chat functionality package that integrates with Fragno
- `examples/react-router-example/` - React Router integration example
- `scripts/` - Build and workspace utility scripts

## Common Commands

### Installation

```bash
bun install --linker=isolated
```

### Building

```bash
bun run build              # Build all packages
bun run build:watch        # Build in watch mode
```

### Development

```bash
# Type checking (run in specific package directories)
bun run check

# Testing (uses vitest)
bunx vitest               # Run tests
bunx vitest --watch       # Watch mode

# Linting and formatting
bun run lint              # Lint all files
bun run lint:fix          # Fix lint issues
bun run format            # Format with prettier
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

### Fragno Core (`packages/fragno/src/`)

- `mod.ts` - Main entry point, exports `createLibrary` function and types
- `api/` - Server-side framework with route handling, validation, and request context
- `client/` - Client-side implementations with type-safe hooks and query builders
- `api/internal/` - Internal routing and path parameter utilities

### Route System

Routes are defined with typed configurations:

```typescript
addRoute({
  method: "GET",
  path: "/echo/:message",
  outputSchema: z.string(),
  handler: async ({ pathParams }) => pathParams.message,
});
```

### Client System

Type-safe client hooks are generated from route definitions:

```typescript
const client = createClientBuilder(config, library);
const hook = client.createHook("/echo/:message");
```

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
