# Synchronize sandbox UI state through the Sandbox Manager outbox

Status: open

Created: September 22, 2026

## Goal

Update the sandbox management UI automatically as sandbox lifecycle workflows change persisted
instance state.

The UI should observe transitions such as:

```text
requested -> starting -> running -> stopping -> stopped
                              \-> error
```

without requiring loader revalidation, polling, or a manual page refresh.

## Current state

Sandbox state now belongs to the scope-specific Sandbox Manager Durable Object. The sandbox page
loads a snapshot through `getScopedSandboxRuntime(...).listSandboxes()` and renders that loader
result. A React Router action revalidates the page, but later workflow-owned lifecycle transitions
do not cause another reload.

The Sandbox Manager runtime already enables the Fragno database outbox for both hosted fragments:

- `sandboxManagerFragment`, mounted at `/api/sandbox-manager`;
- `workflowsFragment`, mounted at `/api/sandbox-manager/workflows`.

The missing pieces are an authenticated browser-facing outbox route and a local TanStack DB
projection for the `sandbox_instance` table.

## Ownership boundary

Use the **Sandbox Manager's outbox** as the synchronization source.

Do not mirror sandbox rows into the Automations schema or use Automations lifecycle events as a UI
cache-invalidation protocol. Sandbox lifecycle events delivered to Automations are domain events for
automation processing. The Sandbox Manager database remains the authority for current sandbox state.

Command results remain action-owned transient data. They are not sandbox instance state and do not
need to enter the outbox.

## Plan

### 1. Expose the scoped Sandbox Manager outbox

Add an authenticated resource route with a shape such as:

```text
/api/sandbox-manager-scoped/:scopeKind/:scopeId/*
```

It must:

1. Decode the requested Backoffice scope.
2. Authorize the current principal for that scope.
3. Resolve the matching `SANDBOX_MANAGER` Durable Object identity.
4. Accept only the Fragment internal description and outbox paths required by the browser
   coordinator.
5. Rewrite the request to the `/api/sandbox-manager` mount.
6. Forward streaming responses through the native Durable Object `fetch()` boundary.
7. Use `forwardRequestOwnedResponse()` so cancellation closes upstream outbox work.
8. Remove any caller-provided internal Backoffice context header before forwarding.

Follow the transport behavior of `routes/api/automations-scoped.server.ts`; do not send a streaming
`Response` through Durable Object RPC.

### 2. Define Sandbox Manager browser collections

Add colocated TanStack DB integration under:

```text
app/fragno/sandbox-manager/tanstack/
```

Define a typed `sandboxInstances` collection from:

```ts
sandboxManagerFragmentSchema.tables.sandbox_instance;
```

Create one `FragnoOutboxCoordinator` per scope-specific Sandbox Manager database.

The coordinator must declare both schemas represented by that physical database:

```ts
schemas: [sandboxManagerFragmentSchema, workflowsSchema];
```

One Fragno database has one globally ordered outbox. Even when the page only queries
`sandbox_instance`, workflow mutations share its checkpoint and must be decoded as part of the same
stream.

Use a resource key that distinguishes the canonical scope and physical adapter identity. Reuse the
existing browser collection database primitives where they fit rather than introducing another
independent cache lifecycle.

### 3. Make the sandbox page consume the live collection

Replace the loader-owned sandbox snapshot in `routes/backoffice/automations/sandboxes.tsx` with a
`useLiveQuery` over the `sandboxInstances` collection.

Required behavior:

- The list updates when a sandbox row is created.
- The selected detail view updates as lifecycle fields change.
- Command availability follows the live `status` value.
- A stopped or failed sandbox remains inspectable according to the existing list behavior.
- Scope changes dispose or replace the previous scope's collection resource.
- Initial synchronization has an explicit loading state.
- Synchronization failures have an explicit error state without discarding already materialized
  rows.

The start, execute, and stop operations remain React Router actions. Only persisted sandbox state
moves to the live collection.

### 4. Preserve navigation behavior during synchronization

Starting a sandbox redirects to its detail URL. Ensure the newly created row can arrive through the
already-running outbox coordinator without briefly treating the requested sandbox as permanently
missing.

Stopping a sandbox may continue redirecting to the new-sandbox view, but the sidebar must update as
`stopping` and `stopped` mutations arrive.

Do not add timer-based refreshes as a fallback. Connection recovery and exact checkpoint resume are
owned by `FragnoOutboxCoordinator`.

### 5. Add scenario coverage

Backoffice coverage must exercise real scoped runtime operations and the outbox boundary.

Required scenarios:

1. Open the sandbox collection for an authorized scope.
2. Request a sandbox and observe the row appear without re-running the page loader.
3. Advance the controllable sandbox provider through startup and observe
   `requested -> starting -> running`.
4. Request a stop and observe `stopping -> stopped`.
5. Produce a startup failure and observe the final `error` state and `lastError` value.
6. Reconnect from a persisted outbox checkpoint without duplicating or losing a transition.
7. Prove that organization, project, and user scopes connect only to their own Sandbox Manager.
8. Prove that an unauthorized scoped outbox request is rejected before Durable Object forwarding.
9. Cancel the browser stream and prove request-owned forwarding cancels the upstream response.

Assertions should use final collection and rendered UI state rather than only checking raw outbox
payloads.

## Non-goals

- Moving sandbox state back into Automations.
- Publishing command stdout or stderr through the database outbox.
- Adding a second lifecycle-event protocol specifically for the UI.
- Polling `listSandboxInstances()` from the browser.
- Synchronizing physical Cloudflare sandbox provider internals that are not represented by the
  `sandbox_instance` record.

## Acceptance criteria

This issue is complete when:

- The browser reaches a scope-specific Sandbox Manager outbox through an authenticated native-fetch
  proxy.
- One coordinator owns the Sandbox Manager database checkpoint and includes the Sandbox Manager and
  Workflows schemas.
- The sandbox list and detail views use a typed live `sandbox_instance` collection.
- Lifecycle workflow mutations update the rendered status without manual refresh or loader
  revalidation.
- Automations lifecycle events remain domain events and are not used as the synchronization source.
- Command output remains transient action data.
- Stream cancellation stops upstream work.
- Scope isolation and authorization are covered by Backoffice scenarios.
- Backoffice tests, build, type checks, lint, formatting, and generated checks pass.
