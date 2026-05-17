# Workflow Events + Outbound Step Emissions — Spec

## Open Questions

None. This document captures the agreed intent and an implementation plan actualized for the current
`BufferedDatabasePump`-based step-live pump.

## Intent

The workflows fragment should use one durable concept for inbound workflow communication and one
runtime concept for outbound live output:

- `workflow_event` is the durable inbound log for a workflow instance.
- `workflow_step_emission` is an outbound step stream for active `step.do(...)` callbacks. It
  contains both workflow-authored emissions (`actor = "user"`) and runtime-authored stream metadata
  (`actor = "system"`), such as epoch-start markers.
- The active step-live pump reads unconsumed `workflow_event` rows and delivers them to active step
  callbacks.

This removes the conceptual overlap where `workflow_step_emission.direction = "in"` acts as a second
inbound message mechanism separate from `workflow_event`. The step-emission table may still contain
runtime-authored outbound metadata rows, but it no longer carries inbound messages.

User-facing shape:

```ts
await step.do("interactive", async (tx) => {
  tx.onEvent("message", async (event) => {
    if (shouldAccept(event.payload)) {
      event.consume();
    }
  });

  tx.emit({ type: "status", value: "waiting" });
});
```

Semantics:

- `tx.emit(...)` persists workflow-authored outbound rows in `workflow_step_emission` with
  `actor = "user"`.
- `tx.onEvent(...)` observes durable `workflow_event` rows while a step is actively running.
- `event.consume()` queues a durable event-consumption mutation.
- `consumedByStepKey` and `deliveredAt` are written only if the enclosing `step.do(...)` callback
  completes successfully.
- If the step retries or replays before commit, the event remains unconsumed and is delivered again.
- Because the runtime does not necessarily know when a retried step originally received an event,
  replayed unconsumed events are delivered as backlog when the handler registers / the pump flushes.
- Events are broadcast to all active nested steps that registered a matching handler.
- If multiple nested steps call `consume()` for the same event, which `consumedByStepKey` wins is
  undefined behavior. The supported guarantee is only that a successful step may consume the event.

## Current Code Baseline

This plan is actualized for these current modules:

- `packages/fragno-db/src/buffered-pump.ts`
- `packages/fragment-workflows/src/runner/step-live-pump.ts`
- `packages/fragment-workflows/src/runner/step.ts`
- `packages/fragment-workflows/src/definition.ts`
- `packages/fragment-workflows/src/schema.ts`

Important current structure:

1. `BufferedDatabasePump` owns the generic pump mechanics:
   - one pump per logical key via `BufferedPumpRegistry`;
   - active scopes via `openScope(key, meta)`;
   - optional scope-meta resolution via `resolveScopeMeta(...)`;
   - scope lookup helpers: `hasScope(...)`, `getScopeMeta(...)`, `scopeCount()`;
   - scoped outgoing queues via `scope.enqueueOutgoing(...)`;
   - DB-backed `flush(context)`;
   - `scopeDeliveries` routed to `scope.onDelivery(...)` handlers;
   - per-scope delivery de-duplication using optional `BufferedScopeDelivery.cursor`;
   - `observedItems` routed to external observers;
   - observer de-duplication using `cursorForObservedItem(item): string | undefined`;
   - snapshots and debug labels.
2. `packages/fragment-workflows/src/runner/step-emission-bus.ts` currently exports the pump factory
   and type aliases. Bring a naming migration into scope by renaming this module to
   `step-live-pump.ts` and renaming the exports:
   - `createWorkflowStepEmissionPump(...)` → `createWorkflowStepLivePump(...)`;
   - `WorkflowStepEmissionPump` → `WorkflowStepLivePump`;
   - `WorkflowStepEmissionPumpRegistry` → `WorkflowStepLivePumpRegistry`;
   - `WorkflowStepEmissionPumpHandle` → `WorkflowStepLivePumpHandle`;
   - `workflowStepEmissionPumpKey(...)` → `workflowStepLivePumpKey(...)`.
3. The current pump factory creates a `BufferedDatabasePump` with:
   - `TOutgoing = TOutEmission`;
   - `TScopeMeta = StepEmissionScopeMeta`;
   - `TObserved = WorkflowStepEmission<TOutEmission, TInEmission>`;
   - `TScopeDelivery = TInEmission`;
   - `TOpenScopeMeta = StepEmissionOpenScopeMeta`;
   - `resolveScopeMeta(...)` deriving `rootStepKey` / `rootEpoch` from active scopes.
4. `WorkflowStepEmission` currently still includes inbound step-emission rows:
   - `WorkflowStepEmissionOutbound` has `direction: "out"`;
   - `WorkflowStepEmissionInbound` has `direction: "in"`;
   - control rows are still written with `direction: "control"` and `STEP_STARTED_PAYLOAD`;
   - direct inbound writes use `sendStepEmission(...)` in `definition.ts`;
   - active delivery uses `scopeDeliveries` derived from persisted `direction === "in"` rows.
5. `RunnerStep.do(...)` currently:
   - gets a pump handle from `BufferedPumpRegistry` using `workflowStepEmissionPumpKey(...)`;
   - opens a scope with `pump.openScope(identity.stepKey, { stepKey, epoch })`;
   - maps `tx.emit(...)` to `emissionScope.enqueueOutgoing(...)`;
   - maps `tx.onEmission(...)` to `emissionScope.onDelivery(...)`;
   - flushes/closes the scope and queues emission cleanup in `finally`.
6. `workflow_step_emission` currently has:
   - nullable `sequence` because inbound rows are written with `sequence: null`;
   - `direction` because rows can be `control`, `out`, or `in`;
   - created-at oriented indexes:
     - `idx_workflow_step_emission_instance_createdAt_sequence_id`
     - `idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id`
     - `idx_workflow_step_emission_instance_direction_createdAt_sequence_id`

The implementation should reuse `BufferedDatabasePump`; do not reintroduce a bespoke polling loop or
subclass unless there is a concrete need.

## Terminology

- **Event**: durable inbound row in `workflow_event`.
- **Emission**: outbound row in `workflow_step_emission`; may be workflow-authored
  (`actor = "user"`) or runtime-authored (`actor = "system"`).
- **Pump**: the `BufferedDatabasePump` instance keyed by workflow name + instance id.
- **Scope**: a `BufferedDatabasePump` active scope for one running workflow step.
- **Active step**: a `step.do(...)` callback currently executing in-process with an open pump scope.
- **Event delivery**: invoking a registered `tx.onEvent(...)` handler with a durable event row.
- **Event consumption**: committing `consumedByStepKey` and `deliveredAt` to `workflow_event`.
- **Backlog delivery**: delivery of existing unconsumed events to a registered handler.

## Goals

1. Make `workflow_step_emission` outbound-only by removing inbound step-emission rows while keeping
   runtime-authored outbound stream metadata.
2. Route inbound live messages through `workflow_event`, not `workflow_step_emission`.
3. Use `BufferedDatabasePump.scopeDeliveries` for durable event delivery to active scopes.
4. Replace public `tx.onEmission(...)` inbound terminology with `tx.onEvent(...)`.
5. Let user code manually consume an event with `event.consume()`.
6. Commit manual event consumption only when the enclosing step succeeds.
7. Replay unconsumed events on retry/re-execution.
8. Broadcast matching events to all nested active steps.
9. Preserve `step.waitForEvent(...)` as the durable blocking consumption primitive.
10. Keep `sendEvent(...)` durable and wake/tick based even when no active process exists.

## Non-goals

- No exactly-once delivery for `tx.onEvent(...)` handlers.
- No deterministic winner if several nested active steps consume the same event.
- No new queue/lease table for event delivery in this pass.
- No global ordering across concurrently active steps.
- No attempt to make non-idempotent side effects in `onEvent` handlers safe.
- No replacement of `BufferedDatabasePump`.

## User-facing API

### `WorkflowStepTx`

Replace inbound emission terminology with event terminology:

```ts
export type WorkflowStepEvent<TPayload = unknown> = {
  id: string;
  type: string;
  payload: Readonly<TPayload>;
  timestamp: Date;
  consume(): void;
};

export type WorkflowStepEventHandler<TPayload = unknown> = (
  event: WorkflowStepEvent<TPayload>,
) => void | Promise<void>;

export type WorkflowStepTx<TOutEmission = unknown, TInEvent = unknown> = {
  serviceCalls: (factory: () => readonly AnyTxResult[]) => void;
  mutate: (fn: (ctx: HandlerTxContext<HooksMap>) => void) => void;
  onTerminalError: {
    mutate: (fn: (ctx: HandlerTxContext<HooksMap>) => void) => void;
  };
  emit: (payload: TOutEmission) => void;
  onEvent: (type: string, handler: WorkflowStepEventHandler<TInEvent>) => () => void;
};
```

Compatibility decision:

- This is a full breaking change. Remove `tx.onEmission(...)` rather than keeping a compatibility
  alias.
- Do not add a catch-all event handler in this pass. `onEvent` takes an exact event type string.

### `WorkflowStep`

Keep the existing durable blocking primitive:

```ts
waitForEvent<T = unknown>(
  name: string,
  options: { type: string; timeout?: WorkflowDuration },
): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }>;
```

`waitForEvent(...)` remains exclusive durable consumption of the first matching unconsumed event.

## Data Model

### `workflow_event`

Keep the table as the durable inbound log:

```ts
workflow_event;
id;
instanceRef;
actor;
type;
payload;
createdAt;
deliveredAt;
consumedByStepKey;
```

Current required index remains:

```ts
idx_workflow_event_instanceRef_createdAt: ["instanceRef", "createdAt"];
```

Add this index if event pumping needs type-selective reads under load:

```ts
idx_workflow_event_instanceRef_type_createdAt: ["instanceRef", "type", "createdAt"];
```

Consumption semantics:

- `consumedByStepKey === null` means the event is available to `waitForEvent(...)` and
  `tx.onEvent(...)`.
- `event.consume()` queues an update for this row.
- During successful step commit, update the row with:

```ts
{
  consumedByStepKey: currentStepKey,
  deliveredAt: now,
}
```

### `workflow_step_emission`

Target table is outbound-only and mirrors `workflow_event` by recording who emitted the row:

```ts
workflow_step_emission;
id;
instanceRef;
actor; // "user" for tx.emit, "system" for runtime stream metadata
stepKey;
epoch;
sequence;
payload;
createdAt;
```

Exact schema changes from current code:

1. Replace `direction` with `actor`, using
   `.addColumn("actor", column("string").defaultTo("user"))`.
2. Make `sequence` non-nullable. The current nullability exists because inbound rows are written
   with `sequence: null`; outbound-only rows should always have a deterministic order within a
   flush.
3. Keep created-at oriented indexes that match current reader behavior:

```ts
idx_workflow_step_emission_instance_createdAt_sequence_id[
  ("instanceRef", "createdAt", "sequence", "id")
];

idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id[
  ("instanceRef", "stepKey", "epoch", "createdAt", "sequence", "id")
];
```

4. Replace the direction index with an actor index if callers need to separate system and user rows
   efficiently:

```ts
idx_workflow_step_emission_instance_actor_createdAt_sequence_id[
  ("instanceRef", "actor", "createdAt", "sequence", "id")
];
```

Migration note:

- Existing `workflow_step_emission` rows are ephemeral and may be dropped.
- If preserving rows, map `direction = "control"` to `actor = "system"`, map `direction = "out"` to
  `actor = "user"`, and drop `direction = "in"` rows.
- This is a full breaking change. Compatibility is not a concern.

## Execution Model

### Sending an event

`sendEvent(workflowName, instanceId, options)` continues to:

1. Resolve the instance.
2. Reject terminal instances.
3. Create a `workflow_event` row.
4. Trigger `onWorkflowEnqueued` with `reason: "event"`.

Live delivery is an optimization:

- The active step pump polls every `WORKFLOW_STEP_EMISSION_PUMP_INTERVAL_MS`, so correctness does
  not require synchronous notification from `sendEvent(...)`.
- If the service layer later has an ergonomic post-commit hook, it can call
  `deps.stepEmissions.get(workflowStepEmissionPumpKey(...))?.flushNow()` after the event commits.
- Do not attempt to deliver events before the `workflow_event` row is committed.

### Registering an event handler

`tx.onEvent(type, handler)`:

1. Registers a wrapper with the current pump scope's `onDelivery(...)`.
2. Records that the scope has at least one handler for `type` so the flush can avoid delivering
   unrelated event types.
3. Keeps/starts the pump running.
4. The next flush reads unconsumed `workflow_event` rows matching active handler types.
5. Matching backlog events are delivered in deterministic order: `createdAt ASC`, then `id ASC`.
6. The returned unsubscribe removes that handler and decrements the scope's registered type count.

Primary API requires an event `type` string. No catch-all.

### Pumping events into active steps

`writeWorkflowStepEmissionFlush(...)` becomes the single DB-backed pump function for both outbound
emission persistence and inbound event delivery:

1. Retrieve the workflow instance.
2. Retrieve outbound `workflow_step_emission` rows for observation/snapshot, including both
   `actor = "system"` epoch markers and `actor = "user"` workflow emissions.
3. Retrieve unconsumed `workflow_event` rows for the instance.
4. Write queued outbound emissions from `batch.outgoingByScope`.
5. Return `observedItems` containing outbound step-stream rows only: system epoch markers plus user
   emissions.
6. Return `scopeDeliveries` containing `WorkflowStepEvent` objects for matching active scopes.

Event delivery filtering:

- exclude system events via `isSystemEventActor(...)`;
- require `consumedByStepKey === null`;
- deliver only events whose `type` has at least one handler on that scope;
- return `cursor: event.id.toString()` for each `BufferedScopeDelivery`, relying on
  `BufferedDatabasePump`'s per-scope delivery cursor set to prevent duplicate delivery within one
  active attempt;
- sort by `createdAt`, then `id`.

Do not write `deliveredAt` or `consumedByStepKey` during pump delivery.

### Consuming an event

`event.consume()` is synchronous and queues an intended event consumption. It must not perform I/O.

Implementation rule:

- The queued mutation lives with the enclosing step's success path, not with the pump transaction.
- If the callback succeeds and the step is persisted as completed, the queued event update is
  applied by `applyRunnerMutations(...)`.
- If the callback throws, suspends, retries, times out, or is replayed without running, the queued
  consumption is discarded.

### Retry and replay semantics

If a step receives an event, calls `consume()`, and then fails before step commit:

- the event row remains unconsumed;
- the next attempt registers `onEvent(...)` again;
- the event is delivered as backlog;
- user handler code may run again.

This is intentional. `onEvent` handlers are replayable.

### Nested active steps

Events are broadcast to all matching active scopes.

If multiple nested steps call `consume()` for the same event:

- the result is undefined;
- implementation may allow last queued update to win;
- tests should only assert that the event becomes consumed by one of the expected step keys.

## Exact Implementation Plan

### 1. Update public workflow types

File: `packages/fragment-workflows/src/workflow.ts`

Changes:

1. [x] Add `WorkflowStepEvent<TPayload>` with `id`, `type`, `payload`, `timestamp`, and `consume()`.
2. [x] Add `WorkflowStepEventHandler<TPayload>`.
3. [x] Remove public `WorkflowStepEmissionHandler<TInEmission>` or keep it only as a
       private/internal alias if another module still needs it during the same branch.
4. [x] Change `WorkflowStepTx`:
   - [x] keep `emit(payload)`;
   - [x] replace `onEmission(handler)` with `onEvent(type, handler)`.
5. [x] Rename generic docs from `TInEmission` to `TInEvent` where the generic refers to inbound
       durable events.
6. [x] Update JSDoc:
   - [x] `emit` is outbound-only;
   - [x] `onEvent` receives durable workflow events;
   - [x] `consume()` commits only on successful step completion;
   - [x] handlers may replay.

### 2. Make schema emissions outbound-only

File: `packages/fragment-workflows/src/schema.ts`

Changes:

1. [x] Replace `.addColumn("direction", column("string"))` with
       `.addColumn("actor", column("string").defaultTo("user"))` in `workflow_step_emission`.
2. [x] Change `.addColumn("sequence", column("integer").nullable())` to
       `.addColumn("sequence", column("integer"))`.
3. [x] Replace `idx_workflow_step_emission_instance_direction_createdAt_sequence_id` with
       `idx_workflow_step_emission_instance_actor_createdAt_sequence_id` if actor-filtered queries
       are needed.
4. [x] Keep:
   - [x] `idx_workflow_step_emission_instance_createdAt_sequence_id`
   - [x] `idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id`
5. [x] Optionally add `idx_workflow_event_instanceRef_type_createdAt` if tests or profiling show the
       instance-wide event scan is too broad.
6. [x] Keep the `emissionInstance` reference.

### 3. Rename and refactor the step live pump around current `BufferedDatabasePump`

File rename:

- [x] Rename `packages/fragment-workflows/src/runner/step-emission-bus.ts` to
      `packages/fragment-workflows/src/runner/step-live-pump.ts`.

Export renames:

- [x] Rename `createWorkflowStepEmissionPump(...)` to `createWorkflowStepLivePump(...)`.
- [x] Rename `WorkflowStepEmissionPump` to `WorkflowStepLivePump`.
- [x] Rename `WorkflowStepEmissionPumpRegistry` to `WorkflowStepLivePumpRegistry`.
- [x] Rename `WorkflowStepEmissionPumpHandle` to `WorkflowStepLivePumpHandle`.
- [x] Rename `workflowStepEmissionPumpKey(...)` to `workflowStepLivePumpKey(...)`.

Keep:

- [x] the factory-based shape;
- [x] the pump type alias;
- [x] the pump registry and handle aliases;
- [x] the pump key helper;
- [x] `BufferedPumpRegistry` use;
- [x] `resolveScopeMeta(...)` deriving `rootStepKey` and `rootEpoch`;
- [x] `scope.enqueueOutgoing(...)` for `tx.emit(...)`;
- [x] `scope.flushAndClose()` behavior;
- [x] observer/snapshot APIs backed by `observedItems`.

Change observed/delivery types:

1. [x] Replace the `WorkflowStepEmission` union with outbound-only observed items that include
       `actor`:

```ts
export type WorkflowStepEmission<TMessage = unknown> = {
  id: string;
  actor: "user" | "system" | string;
  stepKey: string;
  epoch: string;
  sequence: number;
  payload: TMessage;
  createdAt: Date;
};
```

2. [x] Remove `WorkflowStepEmissionInbound` and all `direction` fields from exported emission types.
3. [x] Change the pump delivery type from `TInEmission` to `WorkflowStepEvent<TInEvent>`.
4. [x] Extend open/scope meta for event delivery:

```ts
type StepEmissionOpenScopeMeta = {
  stepKey: string;
  epoch: string;
  queueEventConsumption: (event: WorkflowEventRecord, consumedByStepKey: string) => void;
};

type StepEmissionScopeMeta = StepEmissionOpenScopeMeta & {
  rootStepKey: string;
  rootEpoch: string;
  eventTypeCounts: Map<string, number>;
};
```

The `eventTypeCounts` map is intentionally mutable. `BufferedDatabasePump` snapshots hold the same
meta object reference, so `writeWorkflowStepEmissionFlush(...)` can see the current registered event
types without changing `BufferedDatabasePump`.

Change behavior:

1. [x] Keep `STEP_STARTED_PAYLOAD`, but write epoch-start marker rows with `actor: "system"` instead
       of `direction: "control"`. These rows are outbound runtime metadata and are required so
       clients can discover active epochs when the same step key runs concurrently across server
       instances.
2. [x] Write workflow-authored `tx.emit(...)` rows with `actor: "user"` instead of
       `direction: "out"`.
3. [x] Remove all `direction: "in"` reads/writes and delete `matchesInboundTarget(...)`; event
       delivery is based on active scopes and registered event types, not persisted step-emission
       targets.
4. [x] In `writeWorkflowStepEmissionFlush(...)`:
   - [x] retrieve `workflow_event` rows ordered by `idx_workflow_event_instanceRef_createdAt`;
   - [x] filter to unconsumed, non-system events whose type is present in a scope's
         `eventTypeCounts`;
   - [x] ensure each active scope has a system epoch-start marker row;
   - [x] append user emission rows for each scope's outgoing batch;
   - [x] map retrieved/created `workflow_step_emission` rows by `actor`, not `direction`;
   - [x] build outbound-only `observedItems` from retrieved and created step-stream rows;
   - [x] build `scopeDeliveries` with `cursor: event.id.toString()` and a `WorkflowStepEvent`
         message.
5. [x] `cursorForObservedItem` should continue returning `item.id`.
6. [x] `BufferedDatabasePump` now handles per-scope delivery de-duplication via delivery cursors, so
       no additional `#deliveredEventIdsByScope` map is needed in this file.

### 4. Queue event consumption in the step success path

Files:

- [x] `packages/fragment-workflows/src/runner/state.ts`
- [x] `packages/fragment-workflows/src/runner/step.ts`
- [x] `packages/fragment-workflows/src/runner/plan-writes.ts`

Current `RunnerMutationBuffer.eventUpdates` can perform the final write, because `plan-writes.ts`
already fills `deliveredAt` when `consumedByStepKey` is set.

Changes:

1. [x] Add a per-step pending event-consumption buffer inside `RunnerStep.do(...)`, next to
       `txQueue`.
2. [x] Pass a `queueEventConsumption(event, stepKey)` callback into `pump.openScope(...)` through
       `StepEmissionOpenScopeMeta`.
3. [x] `event.consume()` adds `{ event, consumedByStepKey: currentStepKey }` to the per-step pending
       buffer.
4. [x] On callback success, after `txQueue.commitSuccess()`, merge pending event consumptions into
       `state.mutations.eventUpdates`.
5. [x] On callback failure/suspension/retry, discard pending event consumptions.
6. [x] Leave `applyRunnerMutations(...)` event update logic mostly unchanged.

Do not enqueue `event.consume()` directly into `state.mutations.eventUpdates` at handler time; that
would violate the success-only commit rule.

### 5. Wire `RunnerStep.do(...)` to event delivery

File: `packages/fragment-workflows/src/runner/step.ts`

Changes:

1. [x] Keep current `BufferedPumpRegistry.getOrCreate(...)` usage, updated to
       `workflowStepLivePumpKey(...)`.
2. [x] Update `pump.openScope(...)` call to include the event-consumption callback:

```ts
const emissionScope = emissionBusHandle.pump.openScope(identity.stepKey, {
  stepKey: identity.stepKey,
  epoch: this.#createEpoch(),
  queueEventConsumption,
});
```

3. [x] Build `tx` with:

```ts
emit: (payload) => emissionScope.enqueueOutgoing(payload),
onEvent: (type, handler) => registerScopeEventHandler(emissionScope, type, handler),
```

4. [x] `registerScopeEventHandler(...)` should:
   - [x] increment `emissionScope.meta.eventTypeCounts` for `type`;
   - [x] call `emissionScope.onDelivery(...)` with a wrapper that only invokes `handler` when
         `event.type === type`;
   - [x] return an unsubscribe that removes the delivery handler and decrements/deletes the count;
   - [x] optionally trigger `void livePumpHandle.pump.flushNow().catch(...)` so backlog is delivered
         promptly. It is also acceptable to rely on the normal pump interval.
5. [x] Replace the no-op `onEmission` in `#createStepTxQueue()` with no-op `onEvent`.
6. [x] Keep `await emissionScope.flushAndClose()` and `await livePumpHandle.close()` in `finally`.
7. [x] Keep `#queueStepEmissionCleanup(...)`; cleanup now deletes outbound rows only because those
       are the only remaining rows in `workflow_step_emission`.

### 6. Update workflow services

File: `packages/fragment-workflows/src/definition.ts`

Changes:

1. [x] Remove `sendStepEmission(...)`; inbound live messages are now `sendEvent(...)`.
2. [x] Keep `observeStepEmissions(...)`, but type it as outbound observation only:

```ts
observeStepEmissions<TOutEmission = unknown>(...): WorkflowStepLivePumpHandle<TOutEmission>
```

3. [x] Keep `sendEvent(...)` durable behavior.
4. [x] Optional prompt-delivery optimization: after an event commits, flush the local pump for the
       instance. If the service transaction API has no clean post-commit hook, skip this and rely on
       the pump interval.
5. [x] Update `buildEmissionHistoryEntry(...)` to include `actor` and omit `direction`.
6. [x] Update `listHistory(...)` emission query to use
       `idx_workflow_step_emission_instance_createdAt_sequence_id` or the actor index, not the
       direction index.
7. [x] Update `onWorkflowStepEmissionsCleanup` to keep using
       `idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id`.

### 7. Update routes and client schemas

Files:

- [x] `packages/fragment-workflows/src/routes.ts`
- [x] `packages/fragment-workflows/src/client/routes.ts`
- [x] `packages/fragment-workflows/src/definition.ts`

Changes:

1. [x] Replace `direction` with `actor` in `historyEmissionSchema`.
2. [x] Replace `direction` with `actor` in `WorkflowsHistoryEmission`.
3. [x] Update route responses and tests accordingly.
4. [x] Keep history response shape:

```ts
{
  steps: [...],
  events: [...],
  emissions: [...]
}
```

where `emissions` now means outbound step-stream rows only, including system epoch markers and user
emissions.

### 8. Update scenario/test helper API

File: `packages/fragment-workflows/src/scenario.ts`

Changes:

1. [x] Replace scenario `sendStepEmission` with `sendEvent` where the intent is inbound
       communication.
2. [x] Replace any `direction` option in `getEmissions(...)` with optional `actor` filtering if
       needed.
3. [x] Update `getEmissions(...)` query to use the created-at index or actor index.
4. [x] Add scenario coverage for active `tx.onEvent(...)` if useful for higher-level tests.

### 9. Update direct tests and fixtures

Files likely affected:

- [x] `packages/fragment-workflows/src/runner.test.ts`
- [x] Rename `packages/fragment-workflows/src/runner/step-emission-bus.test.ts` to
      `packages/fragment-workflows/src/runner/step-live-pump.test.ts`
- [x] `packages/fragment-workflows/src/scenario-runner.test.ts`
- [x] `packages/fragment-workflows/src/services.test.ts`
- [x] `packages/fragment-workflows/src/index.test.ts`
- [x] `packages/fragment-workflows/src/user-scenarios.test.ts`

Changes:

1. [x] Replace manual `workflow_step_emission` fixture rows that include `direction`.
2. [x] Replace inbound step-emission tests with event-pump tests.
3. [x] Update user-emission expectations to assert `actor: "user"` instead of `direction: "out"`.
4. [x] Update epoch-marker expectations to assert `actor: "system"` instead of
       `direction: "control"`.
5. [x] Update type tests/examples from `tx.onEmission` to `tx.onEvent`.

## Tests to Add

### Buffered pump integration tests

1. [x] `createWorkflowStepLivePump(...)` still uses `BufferedDatabasePump` scopes: `tx.emit(...)`
       queues outgoing items and flush persists outbound emissions.
2. [x] `BufferedDatabasePump.scopeDeliveries` deliver `WorkflowStepEvent` objects to active step
       scopes.
3. [x] Delivery cursor de-duplication prevents repeated event delivery to the same scope within one
       active attempt.
4. [x] Pump observer de-duplication still works with outbound item id cursors.
5. [x] Pump errors restore drained outbound queues, preserving current `BufferedDatabasePump`
       behavior.
6. [x] `resolveScopeMeta(...)` still rejects nested steps when the root step is not active.

### API/type tests

1. [x] `tx.emit(payload)` accepts the workflow outbound emission payload type and returns `void`.
2. [x] `tx.onEvent(type, handler)` receives a typed `WorkflowStepEvent<TInEvent>`.
3. [x] `event.consume()` is available and returns `void`.
4. [x] Existing workflows without explicit emission/event generics still compile with `unknown`.

### Schema/history tests

1. [x] `workflow_step_emission` rows have `actor`, not `direction`.
2. [x] `workflow_step_emission.sequence` is non-null for outbound rows.
3. [x] History emissions include `actor` and omit `direction`.
4. [x] History events still include `deliveredAt` and `consumedByStepKey`.
5. [x] Outbound emissions are listed by `createdAt`, `sequence`, `id` order.

### Event pump tests

1. [x] Active `step.do(...)` with `tx.onEvent("ready", handler)` receives a
       `sendEvent(..., { type: "ready" })` event without waiting for step completion.
2. [x] Handler registration receives backlog: create event first, start step later, register
       handler, and assert handler receives the event.
3. [x] Unrelated event types are not delivered to a typed handler.
4. [x] System events are not delivered to `tx.onEvent(...)` handlers.
5. [x] Multiple unconsumed events are delivered in `createdAt ASC`, then `id ASC` order.
6. [x] Repeated pump flushes do not redeliver the same event to the same active attempt unless the
       step retries and registers again.
7. [x] Unsubscribed handlers stop receiving events.
8. [x] Removing the final handler for a type removes that type from the scope's registered type
       count.

### Manual consume tests

1. [x] If handler calls `event.consume()` and the step completes successfully, the event row has:
   - [x] `consumedByStepKey` set to the step key;
   - [x] `deliveredAt` set to a date.
2. [x] If handler calls `event.consume()` and the step throws/retries, the event remains unconsumed.
3. [x] After retry, the unconsumed event is replayed to the new attempt's handler.
4. [x] If the retried attempt calls `consume()` and succeeds, the event is consumed once.
5. [x] If handler observes but does not consume, a later `waitForEvent(...)` can consume the event.
6. [x] If handler consumes successfully, a later `waitForEvent(...)` does not receive that event.

### Nested/concurrent step tests

1. [x] A parent active step and nested active step both receive a broadcast event when both register
       a matching handler.
2. [x] If both call `consume()`, assert only that the event is consumed by one of the expected step
       keys.
3. [x] Concurrent active steps with different handler types receive only matching event types.
4. [x] Event delivery to nested steps does not use inbound `workflow_step_emission` rows; persisted
       system epoch-marker rows still exist for client stream discovery.

### Outbound emission tests

1. [x] `tx.emit(...)` writes outbound rows with `actor: "user"` and deterministic ordering by
       `createdAt`, `sequence`, `id`.
2. [x] Each active scope writes a persisted epoch-start marker with `actor: "system"`, allowing
       clients to discover concurrent epochs for the same step key.
3. [x] Observers still receive outbound rows from local and remote pump flushes.
4. [x] `snapshot()` returns outbound step-stream rows only, including system epoch markers and user
       emissions.
5. [x] Completed step replay does not republish outbound emissions.
6. [x] Outbound rows are cleaned up after step completion/suspension/error according to existing
       cleanup semantics.
7. [x] Cleanup does not delete `workflow_event` rows.

### `sendEvent` integration tests

1. [x] `sendEvent(...)` still persists an event and triggers `onWorkflowEnqueued`.
2. [x] `sendEvent(...)` wakes a waiting `waitForEvent(...)` step as before.
3. [x] Event sent while an active step is running is delivered by the pump.
4. [x] Event sent while no active step exists is later consumed by `waitForEvent(...)` or delivered
       as backlog to `tx.onEvent(...)`.

## Concerns to Keep in Mind

### 1. `onEvent` handler side effects are replayable

If a handler performs external side effects before the step commits, those side effects can happen
again after retry:

```ts
tx.onEvent("approval", async (event) => {
  await sendEmail(); // can duplicate on retry
  event.consume();
});
```

Docs should instruct authors to keep handlers pure/idempotent or use durable/idempotent
application-level writes before external effects.

### 2. Backlog delivery timing may surprise users

Because replayed events are delivered when the handler registers or the pump next flushes, not
necessarily at the original wall-clock point, long callbacks can see old events immediately. This is
intentional but must be documented.

### 3. `waitForEvent` and `onEvent(...).consume()` can race conceptually

If one branch consumes an event via `onEvent` while another branch awaits `waitForEvent`, whichever
successful step commits first may determine whether `waitForEvent` can see it. Avoid promising a
strong ordering across concurrent branches.

### 4. Undefined nested consume winner must stay documented

The undefined behavior around multiple nested `consume()` calls is acceptable only if tests and docs
avoid implying deterministic winner semantics.

### 5. The pump must not become the durable scheduler

`sendEvent(...)` must continue to enqueue workflow ticks. The live pump is an optimization for
active steps, not the only delivery path.

### 6. Event retrieval volume

A long-running instance with many old unconsumed events may make every pump expensive. The event
pump should query by registered event types and may need pagination/cursors later.

### 7. Mutable scope metadata discipline

The plan relies on mutable `eventTypeCounts` inside scope meta so `writeWorkflowStepLiveFlush(...)`
can see currently registered handler types. Keep this contained to `step-live-pump.ts` /
`RunnerStep.do(...)`, and do not expose it as public API.

### 8. Cross-process active delivery remains best-effort

A `sendEvent(...)` call in process A cannot directly invoke handlers in process B unless process B's
pump polls or receives a process-local notification from its own runtime. The periodic pump keeps
this acceptable. Durable correctness still comes from stored events and runner ticks.

### 9. Naming migration

The naming migration is in scope for this implementation. Internal runtime names should use "step
live pump" because the pump now coordinates both outbound step-stream rows and inbound durable event
delivery. The persistent output table remains `workflow_step_emission`, and history/user-facing
emission rows may still be called emissions.

## Verification Commands

After implementation, run package-scoped verification through Turbo:

```bash
pnpm exec turbo test --filter=@fragno-dev/workflows --filter=@fragno-dev/pi-fragment --output-logs=errors-only
pnpm exec turbo types:check --filter=@fragno-dev/workflows --filter=@fragno-dev/pi-fragment --output-logs=errors-only
```

Both `@fragno-dev/workflows` and `@fragno-dev/pi-fragment` must pass, because pi-fragment consumes
workflow step emissions for its live session stream.

Run repo lint if the change touches shared typing/docs exports:

```bash
pnpm run lint
```
