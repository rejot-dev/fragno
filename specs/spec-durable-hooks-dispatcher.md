# Durable Hooks Dispatchers — Spec

## 0. Open Questions

None.

## 1. Overview

Durable hooks currently execute immediately after commit, but there is no reliable background
processor for retries or future execution. This spec adds a **process-at time** to durable hooks and
introduces **generic dispatchers** that process durable hooks outside request lifecycles.

The dispatchers must:

- Run pending durable hooks when due (process-at or retry time).
- Use alarms where available (Cloudflare Durable Objects) and polling in Node.
- Work for any database fragment that uses durable hooks.
- Live in `@fragno-dev/db` (not workflow specific).

This also enables workflows (and other fragments) to schedule future work by triggering hooks with
`processAt`, removing the need for workflow-specific dispatchers.

## 2. References

- Durable hooks docs:
  `apps/docs/content/docs/fragno/for-library-authors/database-integration/durable-hooks.mdx`
- Hook implementation: `packages/fragno-db/src/hooks/hooks.ts`
- Internal hooks table/service: `packages/fragno-db/src/fragments/internal-fragment.ts`
- Workflows hook wiring: `packages/fragment-workflows/src/definition.ts`
- Workflows runner scheduling: `packages/fragment-workflows/src/runner/task.ts`
- Historical workflows dispatchers (removed; replaced by db dispatchers)

## 3. Goals / Non-goals

### 3.1 Goals

1. Add **process-at scheduling** to durable hooks (execute no earlier than a real time).
2. Provide **generic dispatchers** for durable hooks:
   - Node: polling with time checks.
   - Cloudflare DO: alarm-based scheduling.
3. Keep **at-least-once** delivery with idempotency keys (no claim system required).
4. Make dispatchers part of `@fragno-dev/db`, not workflow-specific packages.
5. Ensure hook retries fire **even without new mutations**.
6. Update documentation to reflect the new dispatchers and process-at behavior.

### 3.2 Non-goals

- Exactly-once delivery guarantees.
- Building a hosted, global scheduler.
- Replacing the workflows runner/task model (only dispatch/wake mechanism changes).

## 4. Durable Hooks Scheduling

### 4.1 `processAt` option

Extend `TriggerHookOptions` with:

```ts
type TriggerHookOptions = {
  retryPolicy?: RetryPolicy;
  processAt?: Date;
};
```

Semantics:

- `processAt` is an **absolute** timestamp (Date only).
- If `processAt` is in the future, the hook is stored with `nextRetryAt = processAt`.
- If `processAt` is in the past (or omitted), the hook is stored with `nextRetryAt = null` and is
  eligible immediately.
- `processAt` only affects the **first attempt**. Once the hook is executed (or fails), retries use
  the retry policy to set a new `nextRetryAt`.

### 4.2 Storage model

No schema change. `fragno_hooks.nextRetryAt` is repurposed as the **next eligible attempt time** for
both initial scheduling and retries.

Eligibility rule:

- A pending hook is **due** if `nextRetryAt` is `null` or `<= now`.

### 4.3 Hook processing

`processHooks` continues to:

- Fetch pending events that are due.
- Execute hooks with at-least-once semantics.
- Mark hooks as completed or failed (with retries).

Dispatchers are responsible for invoking `processHooks` on schedule; hooks may still run immediately
after commit when due.

## 5. Durable Hooks Processor API

Introduce a small processor interface and a helper to build it from a fragment:

```ts
type DurableHooksProcessor = {
  process: () => Promise<number>;
  getNextWakeAt: () => Promise<Date | null>;
  namespace: string;
};

function createDurableHooksProcessor(fragment: AnyDatabaseFragment): DurableHooksProcessor | null;
```

Behavior:

- Returns `null` if the fragment has no durable hooks configured.
- `process()` runs `processHooks` once and returns the number of hooks processed (completed +
  failed).
- `getNextWakeAt()` returns the earliest due time for pending hooks in the fragment namespace, or
  `null` when none exist. If any pending hook has `nextRetryAt = null`, it returns `new Date()`.

Implementation notes:

- Store a durable hooks config on the fragment instance (`fragment.$internal.durableHooks`) when
  `provideHooks(...)` is used, so the processor can access `{ hooks, namespace, internalFragment }`.
- Add a service helper on the internal fragment to find the earliest pending hook time using
  `idx_namespace_status_retry`.

## 5.1 Transaction Discipline (Required)

All dispatcher and processor database interactions **must** be atomic and go through the standard
transaction boundary:

- Use `fragment.inContext(...)` and `this.handlerTx()` for reads/writes.
- **Do not** use any direct query engine or raw adapter access for hook processing or scheduling.

This follows the transaction rules in
`apps/docs/content/docs/fragno/for-library-authors/database-integration/transactions.mdx`.

## 6. Dispatchers

### 6.1 Node dispatcher (polling)

New entrypoint in `@fragno-dev/db/dispatchers/node`:

```ts
type DurableHooksDispatcher = {
  wake: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
};

function createDurableHooksDispatcher(options: {
  processor: DurableHooksProcessor;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}): DurableHooksDispatcher;
```

Behavior:

- Polls at `pollIntervalMs` (default 5000).
- Each poll checks `getNextWakeAt()`; only calls `process()` when `now >= nextWakeAt`.
- `wake()` triggers an immediate `process()` (with in-flight coalescing).

### 6.2 Cloudflare Durable Object dispatcher (alarms)

New entrypoint in `@fragno-dev/db/dispatchers/cloudflare-do`:

```ts
type DurableHooksDispatcherDurableObjectHandler = {
  fetch?: (request: Request) => Promise<Response>;
  alarm?: () => Promise<void>;
};

function createDurableHooksDispatcherDurableObject<TEnv>(options: {
  createProcessor: (context: { state: DurableObjectState; env: TEnv }) => DurableHooksProcessor;
  onProcessError?: (error: unknown) => void;
}): (state: DurableObjectState, env: TEnv) => DurableHooksDispatcherDurableObjectHandler;
```

Behavior:

- `alarm()` runs `process()` with in-flight coalescing.
- After each run, schedules the next alarm based on `getNextWakeAt()`:
  - If `null`, clear alarm.
  - Else `setAlarm(max(nextWakeAt, now))`.

The dispatcher does not assume anything about the fragment; the caller owns fragment instantiation
and processor creation.

### 6.3 Concurrency + delivery

- Multiple dispatchers may run concurrently; no claim system is required.
- Hooks are at-least-once; idempotency is enforced by `HookContext.idempotencyKey`.
- Dispatchers must coalesce overlapping `process()` calls to avoid uncontrolled fan-out.

## 7. Fragment Integration

### 7.1 Workflows

Update the workflows fragment to rely on durable hooks dispatching:

- When the runner **schedules** a future task (`sleep`, `retry`, `wake`), also call:
  ```ts
  uow.triggerHook("onWorkflowEnqueued", payload, { processAt: runAt });
  ```
- The `onWorkflowEnqueued` hook should call `config.runner?.tick(...)` directly (no
  workflow-specific dispatcher required). The runner already supports concurrent ticks.

This replaces the legacy `@fragno-dev/workflows-dispatcher-*` packages (now removed).

### 7.2 Other fragments (AI, etc.)

Fragments that already use durable hooks can use the same dispatcher API to ensure retries and
scheduled hooks fire on time.

## 8. Packaging & Migration

### 8.1 New exports

Add to `@fragno-dev/db`:

- `createDurableHooksProcessor` (main export)
- `@fragno-dev/db/dispatchers/node`
- `@fragno-dev/db/dispatchers/cloudflare-do`

### 8.2 Deprecations / Replacements

The existing workflow dispatchers are **replaced** by the durable hooks dispatchers:

- `@fragno-dev/workflows-dispatcher-node` (legacy, removed)
- `@fragno-dev/workflows-dispatcher-cloudflare-do` (legacy, removed)

These packages must be updated to either:

- re-export the new db dispatchers as shims, or
- be removed from docs/examples and clearly marked as deprecated.

## 9. Documentation Updates

Update docs to reflect:

- `processAt` semantics for durable hooks.
- The new generic durable hooks dispatchers (Node polling, Cloudflare DO alarms).
- Workflows setup (remove workflow dispatcher packages; use db dispatchers).

Target docs:

- `apps/docs/content/docs/fragno/for-library-authors/database-integration/durable-hooks.mdx`
- `apps/docs/content/docs/workflows/fragment.mdx`
- `apps/docs/content/docs/workflows/quickstart.mdx`
- `apps/docs/content/docs/workflows/runner-dispatcher.mdx`

## 10. Testing & Verification

- Unit tests for `processAt` behavior (not executed until due).
- Unit tests for `getNextWakeAt`.
- Node dispatcher polling/coalescing tests.
- Durable Object dispatcher alarm scheduling tests.
- Workflows integration test: scheduled `sleep` triggers a durable hook with `processAt`.
