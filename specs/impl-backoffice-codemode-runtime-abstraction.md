# Implement Backoffice-owned codemode/shell runtime boundary

## Goal

Backoffice should not depend directly on the concrete `@cloudflare/codemode` and `@cloudflare/shell`
API surface from application code. Those packages are useful upstream references, but the Backoffice
runtime only needs a small, stable subset:

- codemode provider normalization and tool dispatch
- dynamic-worker executor result/options shapes
- filesystem-backed `state.*` tools for codemode scripts
- a state backend over Backoffice `IFileSystem`

Owning that boundary makes normal Node Vitest tests possible without per-test mocks for Cloudflare
shell/codemode packages, and gives us one obvious place to adapt if the upstream packages change.

## Current external API surface used

### From `@cloudflare/codemode`

- `normalizeCode(code)`
- `sanitizeToolName(name)`
- `resolveProvider(provider)`
- `ToolDispatcher`
- Types: `ToolProvider`, `ResolvedProvider`, `ExecuteResult`, `Executor`,
  `DynamicWorkerExecutorOptions`

### From `@cloudflare/shell`

- `FileSystem` shape used by `BackofficeStateFileSystem`
- `FileSystemStateBackend`
- `InMemoryFs.glob(...)` indirectly, only as a glob matcher

### From `@cloudflare/shell/workers`

- `stateToolsFromBackend(...)`

## Implementation plan

1. Add a Backoffice-owned codemode API module.
   - Define the provider/result/executor interfaces we actually use.
   - Implement `normalizeCode`, `sanitizeToolName`, `resolveProvider`, and `ToolDispatcher` locally.
   - Keep `DynamicWorkerExecutor` using these local types.

2. Add a Backoffice-owned state/shell module.
   - Define the filesystem interface consumed by state tools.
   - Implement `BackofficeFileSystemStateBackend` with direct filesystem delegates plus
     `readJson`/`writeJson` helpers.
   - Implement `stateToolsFromBackend` locally with the `state.*` methods Backoffice exposes to
     codemode.

3. Remove application imports from `@cloudflare/codemode`, `@cloudflare/shell`, and
   `@cloudflare/shell/workers`.

4. Replace `InMemoryFs.glob(...)` usage with a small local glob implementation supporting the
   patterns currently covered by tests:
   - `*`
   - `?`
   - `**`
   - simple brace alternates, e.g. `*.{ts,tsx}`

5. Simplify Node tests.
   - Keep `cloudflare:workers` mocked because Durable Object classes and generated dynamic-worker
     modules still import that Workers-only virtual module.
   - Remove shell/codemode module mocks from `starter-otp-linking.test.ts`.

6. Validate.
   - `cd apps/backoffice && pnpm run types:check`
   - `cd apps/backoffice && pnpm exec vitest run app/fragno/codemode/master-file-system-state.test.ts app/fragno/automation/starter-otp-linking.test.ts --config vitest.node.config.ts`
