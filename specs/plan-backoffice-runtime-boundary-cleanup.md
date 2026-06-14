# Backoffice runtime boundary cleanup plan

## Problem

The current object-abstraction changes introduced many APIs that accept both:

```ts
env: CloudflareEnv;
objects?: BackofficeObjectRegistry;
```

That means the abstraction boundary is still unclear. `env` is being used for several different
jobs:

1. Object lookup: `env.X.get(env.X.idFromName(...))`
2. Runtime service fallback: `resolveBackofficeRuntimeServices({ env })`
3. Real platform/config access: secrets, Cloudflare bindings, `ExecutionContext`, loaders, etc.

If the object abstraction is correct, domain/runtime code should not usually need `CloudflareEnv`
once `BackofficeObjectRegistry` and database adapters have been resolved.

## Target rule

`CloudflareEnv` should create the runtime abstraction. It should not travel alongside it.

Preferred flow:

```ts
CloudflareEnv
  -> createCloudflareBackofficeRuntimeServices(env)
  -> { objects, adapters, config }
  -> app/domain/runtime code
```

Avoid this shape in domain APIs:

```ts
{
  (env, objects);
}
```

## Desired boundaries

- Cloudflare boundary code may accept `CloudflareEnv`:
  - Worker `fetch`
  - Durable Object constructors
  - `cloudflare-registry.ts`
  - `cloudflare-database-adapters.ts`
  - Cloudflare-specific config normalization
- Runtime/domain code should accept resolved dependencies:
  - `objects`
  - `adapters`
  - normalized `config` when real secrets/settings are required
- Leaf helpers should accept only the narrow dependencies they actually use.

## Plan

### Runtime service model

- [ ] Replace `BackofficeRuntimeServices.env` with explicit non-platform dependencies.
- [ ] Introduce a normalized `BackofficeRuntimeConfig` for real config/secrets that domain code
      needs.
- [ ] Add `createCloudflareBackofficeRuntimeServices(env)` as the Cloudflare boundary constructor.
- [ ] Keep `resolveBackofficeRuntimeServices({ env })` only as temporary migration glue.
- [ ] Remove deep uses of `resolveBackofficeRuntimeServices({ env })` after call sites are migrated.

### React Router / app context

- [ ] Change `CloudflareContext` to prefer a single runtime field, for example `{ runtime }`.
- [ ] Keep `{ env, ctx }` only as platform escape hatches.
- [ ] Update route loaders/actions to read `runtime.objects` / `runtime.adapters` instead of
      separate `env` and `objects` fields.
- [ ] Remove compatibility context fields once routes no longer need them.

### Route-backed runtimes

Remove `env` from route-backed runtime factories that only need object routing.

- [ ] Update `createRouteBackedRuntimeContext` to accept resolved runtime services or at least
      `{ objects, orgId }` for object-backed families.
- [ ] Update `createAutomationsRouteCaller` and `createWorkflowsRouteCaller` to accept
      `{ objects, orgId }`.
- [ ] Update `createRouteBackedAutomationStoreRuntime` to accept `{ objects, orgId }`.
- [ ] Update `createRouteBackedAutomationWorkflowRuntime` to accept `{ objects, orgId }`.
- [ ] Update `createRouteBackedDurableHooksRuntime` to accept `{ objects, orgId }`.
- [ ] Update `createTelegramRuntime` to accept `{ objects, orgId }`.
- [ ] Update `createResendRouteRuntime` to accept `{ objects, orgId }`.
- [ ] Update `createReson8RouteRuntime` to accept `{ objects, orgId }`.
- [ ] Update `createMcpRuntime` to accept `{ objects, orgId }`.
- [ ] Update `createOtpRuntime` to accept `{ objects, orgId }`.
- [ ] Update `createPiRouteRuntime` to accept `{ objects, orgId }`.
- [ ] Update `createSandboxRouteRuntime` to accept `{ objects, orgId }`.

### File-system helpers

- [ ] Change `CreateOrgFileSystemOptions` to remove `env`.
- [ ] Make `createOrgFileSystem` accept only `{ orgId, objects, automationHookQueue }`.
- [ ] Remove `resolveBackofficeRuntimeServices` from
      `apps/backoffice/app/files/create-file-system.ts`.
- [ ] Replace `if (env.UPLOAD)` style checks with abstraction-level availability.
- [ ] Decide whether optional object families are represented as optional registry members or as
      required unavailable/unconfigured implementations.
- [ ] Change `seedWorkspaceStarterFiles` to accept only `{ orgId, objects, force }`.

### Capability descriptors

Replace capability APIs that currently receive `{ env, objects, orgId }`.

- [ ] Introduce a capability context type, e.g. `BackofficeCapabilityContext`.
- [ ] Include `objects`, `config`, `orgId`, and `origin` in the capability context.
- [ ] Update `BackofficeHookScope.getRepository` to use the capability context.
- [ ] Update connection `getStatus`, `verify`, `reset`, and `configure` to use the capability
      context.
- [ ] Update auth capability to use `objects.auth` directly.
- [ ] Update automations capability to use `objects.automations` directly.
- [ ] Update cloudflare capability to use `objects.cloudflareWorkers` and `config` for
      environment-specific status.
- [ ] Update github capability to use `objects.github` and `config` for GitHub app environment
      status.
- [ ] Update mcp capability to use `objects.mcp` directly.
- [ ] Update otp capability to use `objects.otp` directly.
- [ ] Update pi capability to use `objects.pi` directly.
- [ ] Update resend capability to use `objects.resend` directly.
- [ ] Update reson8 capability to use `objects.reson8` directly.
- [ ] Update telegram capability to use `objects.telegram` directly.
- [ ] Update upload capability to use `objects.upload` directly.

### Durable Objects / workers

- [ ] Resolve runtime services once per DO instance where practical instead of repeatedly calling
      `resolveBackofficeRuntimeServices({ env })`.
- [ ] Pass resolved `objects` and `adapters` into fragment/runtime constructors.
- [ ] Keep Cloudflare DO classes as production wrappers around runtime services.
- [ ] Avoid constructing `createCloudflareBackofficeObjectRegistry(env)` repeatedly in methods.
- [ ] Update in-memory runtime to construct the same runtime service shape as production.

### Compatibility cleanup

- [ ] Remove `objects?` optionality from APIs after migration.
- [ ] Remove overloads that accept either `CloudflareEnv` or options objects.
- [ ] Remove `env as CloudflareEnv` casts introduced by partial-env compatibility.
- [ ] Restrict `resolveBackofficeRuntimeServices` usage to boundary/test setup code.
- [ ] Add lint or grep check documentation for avoiding new `{ env, objects }` domain APIs.

## Acceptance criteria

- [ ] `apps/backoffice/app/files/create-file-system.ts` has no `CloudflareEnv` dependency.
- [ ] Route runtime factories do not accept both `env` and `objects`.
- [ ] Capability descriptors do not call `resolveBackofficeRuntimeServices({ env })` internally.
- [ ] Most app/domain code depends on `BackofficeObjectRegistry` and
      `BackofficeDatabaseAdapterFactory`, not Cloudflare namespaces.
- [ ] Cloudflare-specific object construction is isolated to `backoffice-runtime/cloudflare-*` files
      and worker/DO boundaries.
- [ ] Existing Cloudflare tests continue to pass during the migration.
- [ ] In-memory runtime can provide the same service shape without requiring domain code to know
      about Cloudflare env.
