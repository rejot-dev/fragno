# Plan: Move Backoffice sandbox instances into Automations

## Goal

Replace the standalone `SandboxRegistry` Durable Object with a first-class `sandbox_instance` table
in the Automations fragment.

The table is not a generic “tracking registry”. It is the durable source of truth for
**Backoffice-managed sandbox instances** that should be listable by org/project automation scope.

Key decisions:

- `sandbox_instance` belongs to `apps/backoffice/app/fragno/automation/schema.ts`.
- There is no `trackInstance` / `untrackInstance` API or terminology.
- `id` is the full provider identifier used to address the sandbox runtime.
- Add `provider` now so we can support multiple sandbox providers later.
- Do not add `runtimeName`; the runtime address is `provider + id`.
- Live status remains runtime-derived, not stored as durable truth.
- Sandbox runtime access goes through a provider interface so tests can mock providers and future
  sandbox providers can plug in without changing instance persistence.

## Target data model

Add a table to `automationFragmentSchema`:

```ts
.addTable("sandbox_instance", (t) => {
  return t
    .addColumn("id", idColumn())
    .addColumn("provider", column("string"))
    .addColumn("createdAt", column("timestamp").defaultTo((b) => b.now()))
    .addColumn("updatedAt", column("timestamp").defaultTo((b) => b.now()))
    .createIndex("idx_sandbox_instance_provider", ["provider"]);
})
```

Notes:

- `id` is the complete provider identifier, for example `org_123::dev` for Cloudflare-backed
  sandboxes.
- `provider` can initially be `cloudflare`.
- Because each Automations object is already scoped, the table does not need `orgId`.
- Do not store live `status` unless we later explicitly want cached/stale status.

## Desired terminology

Use:

- `createSandboxInstance`
- `deleteSandboxInstance`
- `listSandboxInstances`
- `getSandboxInstance`
- `SandboxInstanceStore`
- `sandbox_instance`

Avoid:

- `trackInstance`
- `untrackInstance`
- `SandboxRegistry`
- `runtimeName`
- “tracked sandbox”

## Implementation checklist

### 1. Add Automations schema support

- [x] Update `apps/backoffice/app/fragno/automation/schema.ts` with `sandbox_instance`.
- [x] Add `provider` as a required string column.
- [x] Use `idColumn()` for the full provider identifier.
- [x] Add an index for provider-based listing.
- [x] Do not add `runtimeName`.
- [x] Do not add `status`.

### 2. Add sandbox instance types and validation

- [x] Create `apps/backoffice/app/fragno/automation/sandboxes.ts`.
- [x] Define `sandboxProviderSchema`, initially accepting `cloudflare`.
- [x] Define `sandboxInstanceIdSchema` as a trimmed non-empty string.
- [x] Define `sandboxInstanceSchema` with:
  - [x] `id`
  - [x] `provider`
  - [x] `createdAt`
  - [x] `updatedAt`
- [x] Define input schemas for:
  - [x] `listSandboxInstances({ provider?, limit? })`
  - [x] `getSandboxInstance({ id })`
  - [x] `createSandboxInstance({ id, provider })`
  - [x] `deleteSandboxInstance({ id })`

### 3. Add Automations DB services

- [x] Create `apps/backoffice/app/fragno/automation/sandboxes-storage-runtime.ts`.
- [x] Implement `createAutomationSandboxServices(defineService)`.
- [x] Implement `listSandboxInstances` using one `serviceTx()` retrieve.
- [x] Implement `getSandboxInstance` using one `serviceTx()` retrieve.
- [x] Implement `createSandboxInstance` as create-or-update/upsert semantics.
- [x] Implement `deleteSandboxInstance` as delete-if-present semantics.
- [x] Keep services purely persistence-focused; do not call Cloudflare sandbox runtime from inside
      DB services.

### 4. Wire services into the Automations fragment

- [x] Import `createAutomationSandboxServices` in
      `apps/backoffice/app/fragno/automation/definition.ts`.
- [x] Compose sandbox services with store/project services in `providesBaseService`.
- [x] Export public types from `apps/backoffice/app/fragno/automation/index.ts` if useful.

### 5. Replace the registry client abstraction

Current sandbox manager uses this shape:

```ts
type SandboxRegistryClient = {
  getInstances(): Promise<SandboxInstanceSummary[]>;
  getInstance(id: string): Promise<SandboxInstanceSummary | null>;
  trackInstance(id: string): Promise<void>;
  untrackInstance(id: string): Promise<void>;
};
```

Replace it with a persistence-oriented store shape:

```ts
type SandboxInstanceStore = {
  listSandboxInstances(input?: { provider?: string }): Promise<SandboxInstanceRecord[]>;
  getSandboxInstance(input: { id: string }): Promise<SandboxInstanceRecord | null>;
  createSandboxInstance(input: { id: string; provider: string }): Promise<SandboxInstanceRecord>;
  deleteSandboxInstance(input: { id: string }): Promise<void>;
};
```

- [x] Rename the manager dependency from `registry` to `instances` or `instanceStore`.
- [x] Remove every `trackInstance` call.
- [x] Remove every `untrackInstance` call.
- [x] Keep lifecycle language in `CloudflareSandboxManager`: start, list, get handle, kill.

### 6. Update Cloudflare sandbox manager behavior

File: `apps/backoffice/app/sandbox/cloudflare-sandbox-manager.ts`

- [x] Add a provider constant, probably `const CLOUDFLARE_SANDBOX_PROVIDER = "cloudflare" as const`.
- [x] Treat `scopedSandboxId` as the persisted `sandbox_instance.id`.
- [x] On `startInstance`:
  - [x] normalize public input id.
  - [x] derive the full provider id, currently `${orgId}::${publicId}` when scoped.
  - [x] create/get/configure the Cloudflare sandbox runtime by full id.
  - [x] run the startup command.
  - [x] call `createSandboxInstance({ id: fullId, provider: "cloudflare" })`.
  - [x] resolve live status from runtime.
  - [x] return public id in the route/tool response for current UX compatibility.
- [x] On startup failure:
  - [x] destroy the Cloudflare sandbox if it was created.
  - [x] delete the `sandbox_instance` row only if it was created during this start attempt.
  - [x] use cleanup/error terminology, not untracking terminology.
- [x] On `listInstances`:
  - [x] load rows with provider `cloudflare`.
  - [x] convert each full id back to public id for the current org scope.
  - [x] ask the live runtime for current status.
  - [x] sort by public id.
- [x] On `getHandle`:
  - [x] require a matching `sandbox_instance` row before returning a handle.
  - [x] resolve the Cloudflare sandbox by full id.
- [x] On `killInstance`:
  - [x] resolve full id from public id.
  - [x] destroy the live runtime.
  - [x] delete the `sandbox_instance` row after successful destroy or already-terminated errors.
  - [x] keep the row if the runtime is temporarily unavailable.

### 7. Add Automations object methods

File: `apps/backoffice/app/backoffice-runtime/object-registry.ts`

- [x] Extend `AutomationsObject` with sandbox instance persistence methods:
  - [x] `listSandboxInstances(input?: { provider?: string }): Promise<SandboxInstanceRecord[]>`
  - [x] `getSandboxInstance(input: { id: string }): Promise<SandboxInstanceRecord | null>`
  - [x] `createSandboxInstance(input: { id: string; provider: string }): Promise<SandboxInstanceRecord>`
  - [x] `deleteSandboxInstance(input: { id: string }): Promise<void>`
- [x] Remove `SandboxRegistryObject` entirely.
- [x] Remove `sandboxRegistry` from `BackofficeObjectRegistry`.
- [x] Remove `SANDBOX_REGISTRY` from `BackofficeObjectBindingName`.
- [x] Remove allowed scope configuration for `SANDBOX_REGISTRY`.

File: `apps/backoffice/workers/automations.do.ts`

- [x] Implement the four sandbox instance methods on `InMemoryAutomationsObject`.
- [x] Forward those methods from `Automations`.
- [x] Ensure the Automations object is configured for org scope before DB calls.

### 8. Rewire sandbox manager construction

File: `apps/backoffice/app/worker-runtime/sandbox-manager.ts`

- [x] Remove `getSandboxRegistryDurableObject` import.
- [x] Pass `getAutomationsDurableObject(context, organizationId)` as `instanceStore`.

File: `apps/backoffice/app/fragno/runtime-tools/families/sandbox-route-runtime.ts`

- [x] Replace `objects.sandboxRegistry.forOrg(normalizedOrgId)` with
      `objects.automations.forOrg(normalizedOrgId)`.
- [x] Keep `objects.sandbox.forName(id)` for live Cloudflare sandbox runtime access.

File: `apps/backoffice/app/worker-runtime/durable-objects.ts`

- [x] Delete `getSandboxRegistryDurableObject`.

### 9. Remove standalone SandboxRegistry Durable Object

- [x] Delete `apps/backoffice/workers/sandbox-registry.do.ts`.
- [x] Remove `SandboxRegistry` import/export from `apps/backoffice/workers/app.ts`.
- [x] Remove in-memory factory import of `InMemorySandboxRegistryObject`.
- [x] Remove `SANDBOX_REGISTRY` factory from
      `apps/backoffice/app/backoffice-runtime/in-memory-object-factory.ts`.
- [x] Remove unavailable fallback methods named `trackInstance` / `untrackInstance`.

### 10. Update runtime config and capabilities

File: `apps/backoffice/app/backoffice-runtime/runtime-services.ts`

- [x] Remove `bindings.sandboxRegistry`.
- [x] Remove `Boolean(env.SANDBOX_REGISTRY)`.

File: `apps/backoffice/app/fragno/backoffice-capabilities/capabilities/sandbox.ts`

- [x] Change configured check from `sandbox && sandboxRegistry` to `sandbox && automations`.
- [x] Update next steps text to mention Cloudflare Sandbox and Automations bindings.

File: `apps/backoffice/app/fragno/runtime-tools/route-backed-runtime-context.ts`

- [x] Change sandbox runtime availability from `sandbox && sandboxRegistry` to
      `sandbox && automations`.

### 11. Update Wrangler config

File: `apps/backoffice/wrangler.jsonc`

- [x] Remove the `SANDBOX_REGISTRY` durable object binding.
- [x] Add a new Durable Object migration if we want Cloudflare to delete old registry storage:

```jsonc
{
  "tag": "v18",
  "deleted_classes": ["SandboxRegistry"],
}
```

- [x] Only add `deleted_classes` once code no longer exports or binds `SandboxRegistry`.
- [x] Accept that this deletes old registry-only data; sandboxes can be recreated if needed.

### 12. Update tests

- [x] Update `apps/backoffice/app/sandbox/cloudflare-sandbox-manager.test.ts`:
  - [x] replace registry mocks with instance store mocks.
  - [x] assert `createSandboxInstance` on successful start.
  - [x] assert `deleteSandboxInstance` on kill / cleanup.
  - [x] remove expectations for `trackInstance` / `untrackInstance`.
- [x] Update `apps/backoffice/app/fragno/runtime-tools/families/sandbox-route-runtime.test.ts`.
- [x] Update `apps/backoffice/app/backoffice-runtime/object-registry.test.ts`.
- [x] Update `apps/backoffice/app/backoffice-runtime/cloudflare-registry.test.ts`.
- [x] Update any tests that assert `sandboxRegistry` runtime config.
- [x] Add service tests for Automations sandbox instance persistence.
- [x] Add object-level tests for Automations object sandbox instance methods if there is an existing
      pattern.

### 13. Search-and-destroy old terminology

Run:

```sh
rg "SandboxRegistry|sandboxRegistry|SANDBOX_REGISTRY|trackInstance|untrackInstance|tracked sandbox|runtimeName" apps/backoffice specs
```

- [x] Remove all production references.
- [x] Update tests and docs to the new terminology.
- [x] Leave only historical references if explicitly useful and marked historical.

### 14. Provider abstraction cleanup

- [x] Add a `SandboxRuntimeProvider` interface for provider-specific runtime access.
- [x] Add a generic `SandboxRuntimeHandle` type for provider runtime handles.
- [x] Move Cloudflare SDK adaptation into
      `apps/backoffice/app/sandbox/cloudflare-sandbox-provider.ts`.
- [x] Add `createCloudflareSandboxProvider` as the Cloudflare adapter.
- [x] Update `CloudflareSandboxManager` to depend on the provider interface instead of raw SDK
      objects.
- [x] Update tests to mock the provider interface directly.

### 15. Validate

- [x] Run targeted backoffice tests.

```sh
pnpm exec turbo test --filter=./apps/backoffice --output-logs=errors-only
```

- [x] Run targeted backoffice typecheck.

```sh
pnpm exec turbo types:check --filter=./apps/backoffice --output-logs=errors-only
```

- [x] Run broader validation before merge.

```sh
pnpm exec turbo build types:check test --output-logs=errors-only
```

## Open questions

- [x] Duplicate `createSandboxInstance({ id, provider })` preserves original `createdAt` and only
      bumps `updatedAt`.
- [x] `deleteSandboxInstance` returns `void`.
- [x] `provider` is a strict enum from day one: currently `cloudflare`.
- [x] UI responses keep public ids for current UX compatibility.
