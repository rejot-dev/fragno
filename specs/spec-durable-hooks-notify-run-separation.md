# Durable Hooks Notify/Run Separation — Spec

## Open Questions

None.

## 1. Overview

This spec refactors durable hooks dispatching to separate three concerns that are currently mixed:

1. enqueueing hook records in the transaction,
2. notifying runtime infrastructure that work exists,
3. running hook handlers.

The current request path calls `scheduler.schedule()` fire-and-forget after mutate, which can still
run hook work in-process during request completion. That is incompatible with environments where
in-request execution can deadlock and it is not durable on Cloudflare when the request lifecycle
ends early.

This spec introduces a hard contract:

- request completion path may **enqueue + notify** only,
- background path may **run** hooks,
- Cloudflare notification must persist through `state.waitUntil(...)` + alarm scheduling.

Breaking changes are allowed.

## 2. References

- Hook enqueue + scheduler wiring: `packages/fragno-db/src/db-fragment-definition-builder.ts`
- Hook scheduler and processing internals: `packages/fragno-db/src/hooks/hooks.ts`
- Durable hooks runtime registry: `packages/fragno-db/src/hooks/durable-hooks-runtime.ts`
- Processor abstraction: `packages/fragno-db/src/hooks/durable-hooks-processor.ts`
- Cloudflare DO dispatcher: `packages/fragno-db/src/dispatchers/cloudflare-do/dispatcher.ts`
- Node dispatcher: `packages/fragno-db/src/dispatchers/node/dispatcher.ts`
- Pi message route flow: `packages/pi-fragment/src/routes.ts`
- Workflows sendEvent wake path: `packages/fragment-workflows/src/definition.ts`
- Pi DO runtime wiring: `apps/docs/workers/pi.do.ts`, `apps/docs/app/fragno/pi.ts`
- Existing dispatcher spec (superseded in parts): `specs/spec-durable-hooks-dispatcher.md`

## 3. Deployment Scenarios (Required Behavior)

### 3.1 VPS: web process only (no separate dispatcher process)

- After commit, request path emits notify only.
- Best-effort execution is allowed, but only via async notify handler outside the mutate call stack.
- If notify is dropped, work still remains durable in `fragno_hooks` for later processing.

### 3.2 VPS: web process + dedicated Node dispatcher

- Web process emits notify only.
- Dedicated dispatcher polls and runs due hooks.
- Notify may optionally trigger immediate wake in dispatcher process integration, but request path
  never runs hook handlers directly.

### 3.3 Cloudflare Durable Objects

- Request path emits notify only.
- Notify must schedule/refresh DO alarms and must be attached to
  `DurableObjectState.waitUntil(...)`.
- `alarm()` is the authoritative run path and may run immediately when alarm time is now.

## 4. Goals / Non-goals

### 4.1 Goals

1. Prevent in-request hook execution in `onAfterMutate`.
2. Preserve at-least-once delivery semantics.
3. Make Cloudflare request-side notify durable via `waitUntil`.
4. Keep Node polling dispatchers as primary background runner.
5. Reduce architecture ambiguity by defining explicit enqueue/notify/run boundaries.
6. Keep cross-namespace hook triggering behavior.

### 4.2 Non-goals

- Exactly-once semantics.
- Global distributed scheduler.
- Replacing alarm-based Cloudflare execution model.
- Changing hook payload or retry semantics.

## 5. Proposed Architecture

### 5.1 Enqueue stays transactional

No change to `uow.triggerHook(...)` and `prepareHookMutations(...)` behavior:

- hooks are persisted with namespace/status/retry metadata in the same transaction as user
  mutations.

### 5.2 Introduce explicit Notify interface

Add a notifier contract used by post-commit path:

```ts
type HookNotifyContext = {
  source: "request" | "hook";
  route?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
};

type HookNotifier = {
  notify: (namespace: string, context: HookNotifyContext) => void;
};
```

Rules:

- `notify()` must not execute hook handlers inline.
- `notify()` may enqueue wake signals (poll wake hint, alarm scheduling, in-memory queue).
- `notify()` must be idempotent and coalesce duplicate calls.

### 5.3 Introduce explicit Runner interface

Replace scheduler-style naming with runner-style naming:

```ts
type DurableHooksRunner = {
  namespace: string;
  processDue: () => Promise<number>;
  drain: () => Promise<void>;
  getNextWakeAt: () => Promise<Date | null>;
};
```

`processDue()` is the only API that executes hooks.

### 5.4 Post-commit path becomes notify-only

`scheduleDurableHooksAfterMutate(...)` is replaced with `notifyDurableHooksAfterMutate(...)`:

- gather unique namespaces from `uow.getTriggeredHooks()`,
- call notifier for each namespace,
- do not call `runner.processDue()` or old `scheduler.schedule()`.

### 5.5 Request waitUntil propagation

Add optional request lifecycle context to fragment handler:

```ts
fragment.handler(request, {
  waitUntil?: (promise: Promise<unknown>) => void;
});
```

This value is stored in request context metadata and made available to db fragment post-commit
notify path.

If absent, notify still executes best-effort without lifecycle extension.

### 5.6 Cloudflare dispatcher behavior

Cloudflare dispatcher gets two responsibilities:

1. `notify(...)`: schedule/refresh alarm using `getNextWakeAt()` and attach scheduling promise to
   `waitUntil` (fall back to fire-and-forget when missing).
2. `alarm()`: run `processDue()` (coalesced), then schedule next alarm.

Cloudflare notify must never call `processDue()` directly.

### 5.7 Node dispatcher behavior

Node dispatcher exposes:

- `wake()` -> runs `processDue()` (coalesced),
- `startPolling()/stopPolling()` -> periodic due check,
- `notify()` -> best-effort wake hint (`setImmediate(() => wake())`) without request-stack
  execution.

For dedicated dispatcher process deployments, web process can still emit notify to local dispatcher
instance when co-located; otherwise polling remains sufficient.

## 6. API Changes (Breaking)

### 6.1 `@fragno-dev/db` hooks internals

- Remove/retire exported `HookScheduler` usage in post-commit path.
- Introduce `HookNotifier` and `DurableHooksRunner` contracts.
- Rename processor methods from `process()` to `processDue()` in public dispatcher-facing types.

### 6.2 Durable hooks runtime registration

Current namespace-singleton assumptions are fragile when runtimes are recreated in-process. Replace
namespace lookup with notifier-aware runtime registration:

- runtime registry stores both runner + notifier capability,
- cross-namespace notify resolves runtime and calls notifier only,
- duplicate registration warning remains but no inline scheduling behavior depends on it.

### 6.3 Cloudflare DO dispatcher package

`@fragno-dev/db/dispatchers/cloudflare-do` factory must expose notify-aware handler creation, and
docs/examples must pass `waitUntil` context where available.

### 6.4 Fragment handler signature

All framework adapters continue to work with single-arg `handler(request)`, but the canonical
signature becomes two-arg with optional context.

## 7. Execution Flows

### 7.1 Message send flow (Pi + Workflows)

1. `POST /sessions/:id/messages` enqueues workflow event (`sendEvent`).
2. Mutation commits with hook records.
3. Post-commit notifies workflows namespace.
4. Cloudflare: notify schedules alarm via `waitUntil`; Node: notify hints wake or relies on poller.
5. Background runner executes `onWorkflowEnqueued` and calls workflow tick.

### 7.2 Retry and processAt flow

- Failed hook retry sets `nextRetryAt`.
- Notify may re-schedule alarm/poll wake hint.
- Runner processes only due hooks where `nextRetryAt <= now`.

## 8. Logging and Observability

Add explicit log events:

- `Durable hooks notify requested`
- `Durable hooks notify completed`
- `Durable hooks notify failed`
- `Durable hooks alarm schedule requested` with `source=request|hook|alarm`
- `Durable hooks runner start/processed/failed`

Log fields include namespace, source, route, scheduledAt, nextWakeAt, and elapsed ms.

## 9. Migration Plan

1. Introduce new notifier + runner APIs behind compatibility shims.
2. Convert `onAfterMutate` to notify-only path.
3. Migrate Node and Cloudflare dispatchers to runner/notifier contracts.
4. Add handler lifecycle context (`waitUntil`) and pass through in DO integrations (`Pi`, `auth`,
   `telegram`, `resend` workers).
5. Remove scheduler-based request execution path and old method names.
6. Update docs and examples.

## 10. Testing Requirements

1. Unit: post-commit path never calls runner execution APIs.
2. Unit: notify path calls notifier for own + cross namespaces.
3. Unit: Cloudflare notify attaches alarm scheduling via provided `waitUntil`.
4. Unit: Cloudflare alarm executes runner and reschedules alarm.
5. Unit: Node notify is async hint only; no inline run.
6. Integration: Pi message send on Cloudflare path persists alarm scheduling even when request
   returns immediately.
7. Integration: workflow reply latency no longer depends on request-lifecycle fire-and-forget
   completion.

## 11. Compatibility and Docs

Update:

- `apps/docs/content/docs/fragno/for-users/hook-processors.mdx`
- `apps/docs/content/docs/fragno/for-library-authors/database-integration/durable-hooks.mdx`
- `apps/docs/content/docs/workflows/runner-dispatcher.mdx`
- docs snippets that currently imply request path scheduling executes hooks.

## 12. Locked Decisions

1. Request path must never execute hooks directly.
2. Cloudflare notify must use `waitUntil` when available.
3. Alarm remains the durable Cloudflare execution primitive.
4. Best-effort web-only Node mode is supported but remains non-authoritative versus dedicated
   dispatcher polling.

## 13. FP Issue Plan

Parent issue and child tasks are tracked in FP and linked below:

- Parent: `FRAGNO-rcxbkrpg` — Durable hooks: split notify vs run and make Cloudflare scheduling
  durable
- Children:
  - `FRAGNO-uuljpkuq` — API split and notify-only post-commit path (Spec §5.2-§5.4, §6.1)
  - `FRAGNO-ezwggcbk` — handler lifecycle context + waitUntil propagation (Spec §5.5, §6.4)
  - `FRAGNO-nhomrcaz` — Node dispatcher notifier/polling update (Spec §5.7, §6.1)
  - `FRAGNO-wfnvmykt` — Cloudflare notifier + alarm durability update (Spec §5.6, §6.3)
  - `FRAGNO-zdvosowg` — runtime registry and cross-namespace notify resolution (Spec §6.2)
  - `FRAGNO-bwthxgbj` — integrations, tests, docs, and examples (Spec §7-§11)
