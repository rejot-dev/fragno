# Minimal Workflow Step Message Bus Implementation Plan

## Goal

Replace workflow `emission streaming` event streaming with a minimal step-scoped message bus stored
in one table, so any server instance can observe a running step and later send live control messages
to it.

This remains intentionally **best-effort**, not a fully durable pub/sub system:

- `tx.emit(payload)` returns `void` and buffers outbound messages.
- `tx.onMessage(callback)` registers a callback for inbound messages delivered by the runner's step
  bus loop.
- Buffered outbound messages may be lost if the process exits before the next flush.
- Step-bus rows are temporary and deleted when the owning step is persisted.

## Constraints

- Add exactly one new table: `workflow_step_emission`.
- Treat the table as a step-scoped message bus, despite the table name.
- No generic FragnoDB stream primitive.
- No use of `fragno_hooks` for client-facing messages.
- No new scope/lease table.
- No change to `workflow_event` semantics.
- `workflow_event` remains the durable/replayable workflow input mechanism for `waitForEvent(...)`.
- Step messages are ephemeral live communication for currently running `step.do(...)` callbacks.
- `tx.emit(...)` must return `void`, not `Promise<void>`.
- `tx.emit(...)` takes only a payload. There is no public `type` argument.
- `tx.onMessage(...)` registers callbacks instead of exposing a `pollMessages()` API.
- There is no `public emission-listing(...)` workflow service API in this pass.
- Inbound step messages are broadcast to every active step bus epoch for the target workflow
  instance/run.
- `defineWorkflow` becomes generic over outbound and inbound step-message payload types. Both
  default to `unknown`.
- The runner runs a step bus loop every `100ms` via a named const.
- Each loop transaction retrieves inbound messages for the current step/epoch and flushes queued
  outbound messages.
- Message ordering is by per-epoch `sequence`, **not** `createdAt`.
- The loop transaction must retrieve the current highest sequence for the step epoch, then assign
  the next sequence values for new outbound rows.
- Rows are ignored/deleted after the step has completed/errored/suspended and its step row is
  persisted.
- When a bus transaction returns, invoke process-local callbacks/notifiers so `/events` streams can
  wake immediately.

## Non-goals

- No durable delivery guarantee for `tx.emit`.
- No public lifecycle messages like `step.opened` / `step.closed`.
- No durable cross-instance command model outside the current step bus.
- No same-process workflow live controller fallback for Pi `abort` / `steer`; remove that path and
  re-implement live commands through inbound step messages later.

## Schema

Add `workflow_step_emission` to `packages/fragment-workflows/src/schema.ts`.

Suggested columns:

```ts
.addTable("workflow_step_emission", (t) =>
  t
    .addColumn("id", idColumn())
    .addColumn("instanceRef", referenceColumn())
    .addColumn("runNumber", column("integer"))
    .addColumn("stepKey", column("string"))
    .addColumn("epoch", column("string"))
    .addColumn("sequence", column("integer"))
    .addColumn("direction", column("string")) // "control" | "out" | "in"
    .addColumn("payload", column("json").nullable())
    .addColumn("createdAt", column("timestamp").defaultTo((b) => b.now()))
    .createIndex(
      "idx_workflow_step_emission_instance_run_step_epoch_sequence",
      ["instanceRef", "runNumber", "stepKey", "epoch", "sequence"],
      { unique: true },
    )
    .createIndex("idx_workflow_step_emission_instance_run_direction_createdAt", [
      "instanceRef",
      "runNumber",
      "direction",
      "createdAt",
    ])
    .createIndex(
      "idx_workflow_step_emission_instance_run_step_direction_epoch_sequence",
      ["instanceRef", "runNumber", "stepKey", "direction", "epoch", "sequence"],
    ),
)
.addReference("emissionInstance", {
  type: "one",
  from: { table: "workflow_step_emission", column: "instanceRef" },
  to: { table: "workflow_instance", column: "id" },
})
```

Notes:

- Keep one table only.
- Add the `emissionInstance` reference for the `instanceRef` reference column.
- `direction` is internal bus metadata.
- `epoch` is top-level so queries can filter the active step execution cheaply.
- `sequence` is the ordering source for a step epoch.
- `createdAt` is useful for diagnostics/retention and coarse discovery, but must not be used for
  per-step message ordering.
- The unique epoch sequence index gives concurrent writers a clear conflict point. On sequence
  conflict, the writer can retry: reread max sequence and append again.
- The direction/createdAt index supports finding active control rows and coarse outbound wakeups.
- The step/direction/epoch/sequence index supports direction-filtered reads for one active step
  epoch without relying on `createdAt` for message order.

## Step epoch and control row

Each `step.do(...)` execution creates a fresh `epoch`, e.g. via the configured runtime UUID source.

The runner writes one internal control row for the step execution:

```ts
{
  direction: "control",
  epoch,
  sequence: nextSequence,
  payload: { control: "step-started" },
}
```

This is not a public lifecycle message. It is only a restart boundary. Readers find the latest
`step-started` row for a step scope and treat its epoch as the active epoch. Older rows from
crashed/abandoned epochs are ignored.

Multiple `step.do(...)` executions can be active at the same time due to nested steps. Inbound step
messages are broadcast to all currently active step bus epochs for the instance/run, not routed to a
single "current" step.

## Public workflow API

Extend workflow definitions and step tx typing in `packages/fragment-workflows/src/workflow.ts`.

### Message payload types

Make `defineWorkflow` generic over outbound and inbound step-message payload types, both defaulting
to `unknown`.

Conceptual shape:

```ts
export interface WorkflowDefinition<
  TParams = unknown,
  TOutput = unknown,
  TOutMessage = unknown,
  TInMessage = unknown,
  ...
> {
  name: TName;
  schema?: TInputSchema;
  outputSchema?: TOutputSchema;
  run: WorkflowRunFn<TParams, TOutput, TOutMessage, TInMessage>;
}

export type WorkflowRunFn<
  TParams = unknown,
  TOutput = unknown,
  TOutMessage = unknown,
  TInMessage = unknown,
> = (
  event: WorkflowEvent<TParams>,
  step: WorkflowStep<TOutMessage, TInMessage>,
) => Promise<TOutput> | TOutput;
```

Existing workflows should continue to use `unknown` messages without source changes.

### Step and tx API

```ts
export type WorkflowStepMessageHandler<TInMessage> = (message: TInMessage) => void | Promise<void>;

export type WorkflowStepTx<TOutMessage = unknown, TInMessage = unknown> = {
  serviceCalls: ...;
  mutate: ...;
  onTerminalError: ...;
  emit: (payload: TOutMessage) => void;
  onMessage: (handler: WorkflowStepMessageHandler<TInMessage>) => () => void;
};

export interface WorkflowStep<TOutMessage = unknown, TInMessage = unknown> {
  do<T>(
    name: string,
    callback: (tx: WorkflowStepTx<TOutMessage, TInMessage>) => Promise<T> | T,
  ): Promise<T>;
  sleep(...): Promise<void>;
  sleepUntil(...): Promise<void>;
  waitForEvent(...): Promise<...>;
}
```

Usage for Pi later:

```ts
type PiOutMessage = PiSessionEventStreamItem;
type PiInMessage =
  | { kind: "abort"; commandId: string; reason?: string }
  | { kind: "steer"; commandId: string; input: PiPromptInput };

defineWorkflow<typeof PI_WORKFLOW_NAME, AgentLoopParams, unknown, PiOutMessage, PiInMessage>(
  { name: PI_WORKFLOW_NAME, schema: agentLoopParamsSchema },
  async (event, step) => {
    await step.do("command-0-prompt", async (tx) => {
      tx.onMessage((message) => {
        if (message.kind === "abort") controller.abort();
        if (message.kind === "steer") controller.steer(message.input);
      });

      tx.emit(agentEvent);
      tx.emit({ type: "end" });
    });
  },
);
```

Important semantic: `emit` returning `void` documents that outbound delivery is buffered and
best-effort.

## Runner step bus loop

Add a minimal helper, probably under:

- `packages/fragment-workflows/src/runner/step-message-bus.ts`

Constants:

```ts
export const WORKFLOW_STEP_MESSAGE_BUS_INTERVAL_MS = 100;
```

Responsibilities:

- Own queued outbound payloads for exactly one running `step.do` invocation.
- Own registered inbound `onMessage` handlers.
- Own the step execution `epoch`.
- Track ids of rows it creates or retrieves for this step epoch so step persistence can delete those
  rows by id without adding delete-by-index support.
- Ensure the `step-started` control row is written for the epoch.
- Every `WORKFLOW_STEP_MESSAGE_BUS_INTERVAL_MS`, run one bus transaction that:
  1. Retrieves rows/messages for `instanceRef + runNumber + stepKey + epoch`.
  2. Finds the current highest `sequence` for the epoch.
  3. Retrieves inbound rows with `direction === "in"` and `sequence > lastDeliveredInboundSequence`.
  4. Writes queued outbound rows with `direction === "out"` and next sequence values.
  5. Optionally writes the `step-started` control row first if it has not yet been written.
- After the transaction returns:
  - record ids for retrieved rows and newly created rows;
  - invoke inbound `onMessage` handlers for newly retrieved inbound payloads, in sequence order;
  - invoke the process-local flush notifier if outbound rows were written.
- Flush remaining outbound messages when the step callback exits.
- Stop timer on close.
- Swallow/log bus transaction errors because step bus messaging is best-effort.

The bus loop should not use the normal step mutation queue because queued step mutations only commit
after the step finishes.

## Wiring the bus into `RunnerStep`

`RunnerStep` currently receives:

- `state`
- `taskKind`
- `workflowName`
- `instanceId`
- `runNumber`
- `timestamp`

Add:

- `handlerTx` or a lower-level bus transaction function
- optional message notifier
- runtime UUID source or prebuilt `createEpoch` callback
- a way to pass the bus's known row ids into the runner mutation state for step cleanup

Then in `RunnerStep.do(...)`:

1. Create a step message bus for the step identity.
2. Add `emit(payload)` and `onMessage(handler)` to the tx object.
3. Execute the callback.
4. In `finally`, close the bus and flush any remaining queued outbound messages.
5. Add the bus's known row ids to the runner mutation state for the persisted step scope.
6. Continue with existing success/error/suspend handling.

Pseudo-shape:

```ts
const messageBus = this.#createStepMessageBus(identity);
const tx = {
  ...txQueue.tx,
  emit: (payload) => messageBus?.emit(payload),
  onMessage: (handler) => messageBus?.onMessage(handler) ?? (() => {}),
};

try {
  callbackResult = await callback(tx);
} finally {
  await messageBus?.close();
}
```

Even though `tx.emit` is sync, `close()` is async because final buffered rows should be attempted
before the step persistence mutation deletes the scope. `close()` exposes the known bus row ids so
cleanup can use ordinary id-based deletes.

## Bus transaction details

One bus transaction retrieves inbound rows and flushes outbound rows.

Pseudo-shape:

```ts
const result = await handlerTx()
  .retrieve(({ forSchema }) =>
    forSchema(workflowsSchema).find("workflow_step_emission", (b) =>
      b
        .whereIndex("idx_workflow_step_emission_instance_run_step_epoch_sequence", (eb) =>
          eb.and(
            eb("instanceRef", "=", instanceRef),
            eb("runNumber", "=", runNumber),
            eb("stepKey", "=", stepKey),
            eb("epoch", "=", epoch),
          ),
        )
        .orderByIndex("idx_workflow_step_emission_instance_run_step_epoch_sequence", "asc"),
    ),
  )
  .mutate(({ forSchema, retrieveResult: [rows] }) => {
    const uow = forSchema(workflowsSchema);
    const maxSequence = rows.reduce((max, row) => Math.max(max, row.sequence), -1);
    let nextSequence = maxSequence + 1;

    if (!startedWritten && !rows.some((row) => row.direction === "control")) {
      uow.create("workflow_step_emission", {
        instanceRef,
        runNumber,
        stepKey,
        epoch,
        sequence: nextSequence++,
        direction: "control",
        payload: { control: "step-started" },
      });
    }

    for (const payload of queuedOutbound) {
      uow.create("workflow_step_emission", {
        instanceRef,
        runNumber,
        stepKey,
        epoch,
        sequence: nextSequence++,
        direction: "out",
        payload,
      });
    }

    return rows
      .filter((row) => row.direction === "in" && row.sequence > lastDeliveredInboundSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .map((row) => ({ sequence: row.sequence, payload: row.payload }));
  })
  .execute();
```

After `execute()` resolves:

- Mark outbound payloads in that batch as flushed.
- Record ids for all rows retrieved in the transaction and all rows created by the transaction.
- Update `lastDeliveredInboundSequence` to the highest delivered inbound sequence.
- Call `onMessage` handlers for each inbound payload in sequence order.
- Call `onEmissionFlush` / bus notifier if outbound rows were written.

If the unique sequence index conflicts, retry the transaction by rereading rows and assigning new
sequence numbers.

## Sending inbound step messages

Add a workflow service method in `packages/fragment-workflows/src/definition.ts`:

```ts
sendStepMessage<TInMessage = unknown>(params: {
  workflowName: string;
  instanceId: string;
  payload: TInMessage;
})
```

Behavior:

1. Resolve the workflow instance by `workflowName + instanceId`.
2. Retrieve active `step-started` control rows for the current run. Because bus rows are deleted
   when a step persists, remaining control rows represent currently active step bus epochs.
3. Group control rows by `stepKey` and choose the latest epoch for each active step scope.
   - If no active epoch exists, return/throw `NO_ACTIVE_STEP`.
4. For each active `instanceRef + runNumber + stepKey + epoch`, retrieve rows for that epoch.
5. Compute `max(sequence)` for that epoch.
6. Insert one inbound row per active step epoch:

```ts
{
  instanceRef,
  runNumber,
  stepKey,
  epoch,
  sequence: maxSequence + 1,
  direction: "in",
  payload,
}
```

7. Retry individual epoch appends on sequence conflict by rereading that epoch and assigning a new
   sequence.

This broadcasts the message to all active `step.do(...)` callbacks for the instance/run. This is the
later path for Pi `steer` / `abort`; implementing route behavior can be staged after the bus itself
exists.

## Delete messages when persisting the step

As part of the same mutate phase that creates/updates `workflow_step`, delete bus rows by id for
that persisted step scope.

The minimal implementation does **not** add delete-by-index/range support. Instead:

1. Each step bus transaction records ids for rows it retrieves for its step epoch.
2. The bus records ids it creates for the control row and outbound rows.
3. `close()` flushes remaining outbound messages and exposes the known row ids.
4. `RunnerStep.do(...)` adds those ids to the runner mutation state for the step scope.
5. `applyRunnerMutations` schedules ordinary `uow.delete("workflow_step_emission", id)` operations
   when applying that step's create/update.

This deletes rows known to the running bus. If a process crashes before cleanup, stale rows can
remain; the next execution's fresh epoch keeps readers from treating stale rows as current.

Implementation touchpoints:

- `packages/fragment-workflows/src/runner/state.ts` / mutation state shape for bus row ids by step
  scope.
- `packages/fragment-workflows/src/runner/step.ts` to pass known row ids from the bus into runner
  state.
- `packages/fragment-workflows/src/runner/plan-writes.ts` to delete known emission ids when applying
  each step create/update.

## Process-local notifier for `/events`

Add an optional workflow config callback:

```ts
emissions?: {
  onFlush?: WorkflowEmissionFlushNotifier;
};
```

or flatter:

```ts
onEmissionFlush?: WorkflowEmissionFlushNotifier;
```

When a bus transaction resolves and writes outbound rows, call this function. It is intentionally
process-local and best-effort.

Pi can provide an in-memory emitter keyed by session id:

- `/sessions/:sessionId/events` opens `jsonStream`.
- It writes initial snapshot from durable history.
- It subscribes to the process-local notifier for that session.
- On notification, it queries `workflow_step_emission` rows directly from the route/helper and
  writes new outbound payloads.
- It also polls periodically as a fallback, because a different server instance may flush rows.
- Do not add a public `public emission-listing(...)` workflow service for this pass.

## Replacing current Pi emission-streaming event path

In `packages/pi-fragment/src/pi/workflow/workflow.ts`:

Define the workflow message payload types:

```ts
type PiOutMessage = PiSessionEventStreamItem;
type PiInMessage =
  | { kind: "abort"; commandId: string; reason?: string }
  | { kind: "steer"; commandId: string; input: PiPromptInput };
```

Replace emission-streaming event accumulation and direct event-handler callbacks:

```ts
tx.emission streaming?.setState((state) => ({ events: [...state.events, agentEvent] }));
```

with:

```ts
tx.emit(agentEvent);
```

For the end marker:

```ts
tx.emit({ type: "end" });
```

Remove the same-process live controller mechanism entirely as part of this replacement:

- Remove `controller` from `PiStepEmissionStreaming` usage.
- Remove `onEventHandlers` from `PiStepEmissionStreaming` usage.
- Remove `injectPiLiveCommand` / `attachPiLiveEventHandler` usage from routes.
- `abort` and `steer` should no longer attempt same-process injection.

Later, reimplement `abort` / `steer` via `sendStepMessage(...)` and `tx.onMessage(...)`:

```ts
tx.onMessage((message) => {
  if (message.kind === "abort") {
    controller.abort();
  }
  if (message.kind === "steer") {
    controller.steer(message.input);
  }
});
```

In `packages/pi-fragment/src/routes.ts` `/sessions/:sessionId/events`:

- Stop depending on `attachPiLiveEventHandler` for event delivery.
- Keep initial snapshot from workflow history.
- Poll/read outbound step messages and stream the payloads directly through an internal route/helper
  query, not through a public workflow service method.
- Use the flush notifier to wake the stream immediately when same-process flushes happen.
- Heartbeat behavior can stay.

In `POST /sessions/:sessionId/command`:

- Remove `injectPiLiveCommand(...)` logic.
- For now, all durable commands should go through `workflowsService.sendEvent(...)`.
- Later, route `abort` / `steer` through `workflowsService.sendStepMessage(...)` when
  `tx.onMessage(...)` handling is implemented.
- Do not keep the in-memory controller path.

## Ordering and cursoring

Message order is by `sequence` within an active `stepKey + epoch`. There is no single global order
across multiple concurrently active steps.

Outbound reader state is tracked per active step epoch:

```ts
const cursors = new Map<string, { epoch: string; lastSequence: number }>();
```

Outbound reader algorithm:

```ts
const activeControls = findActiveStepStartedControlRows(instanceRef, runNumber);

for (const control of activeControls) {
  const key = control.stepKey;
  const cursor = cursors.get(key);
  const lastSequence = cursor?.epoch === control.epoch ? cursor.lastSequence : control.sequence;
  const rows = listOutRowsForStepEpoch({
    stepKey: control.stepKey,
    epoch: control.epoch,
    sequenceGreaterThan: lastSequence,
  });

  for (const row of rows.sort((a, b) => a.sequence - b.sequence)) {
    emit(row.payload);
    cursors.set(key, { epoch: control.epoch, lastSequence: row.sequence });
  }
}
```

If a newer `step-started` control row appears for a `stepKey`, switch that step's cursor to the new
epoch and reset `lastSequence` to the control row's sequence.

Inbound delivery algorithm inside each runner step bus loop is the same per-step-epoch idea:

```ts
const inbound = rows
  .filter((row) => row.direction === "in" && row.sequence > lastDeliveredInboundSequence)
  .sort((a, b) => a.sequence - b.sequence);
```

Do not sort or cursor per-step messages by `createdAt`. `createdAt` can be used only for coarse
control-row discovery or wakeup-friendly scans before applying the per-step sequence cursor.

## Testing plan

Workflow fragment tests:

1. `tx.emit(payload)` is available in `step.do` and returns `void`.
2. `tx.onMessage(handler)` registers callbacks and returns an unsubscribe function.
3. `defineWorkflow` can type outbound and inbound payloads, defaulting to `unknown` for existing
   workflows. Explicit generic usage may follow the new breaking generic order.
4. The runner writes a `step-started` control row for a step execution epoch.
5. The step bus transaction retrieves inbound messages and flushes outbound messages in one loop.
6. Outbound rows are written with monotonically increasing per-epoch `sequence` values.
7. Inbound `onMessage` callbacks are invoked in sequence order after the bus transaction resolves.
8. `sendStepMessage(...)` broadcasts one inbound row to each active step bus epoch for the instance
   run.
9. Nested active `step.do(...)` callbacks both receive a broadcast inbound message.
10. Sequence conflicts during outbound flush retry by rereading the epoch and appending with the
    next sequence.
11. Sequence conflicts during `sendStepMessage(...)` retry independently per active step epoch.
12. Flush notifier is called after a successful bus transaction that writes outbound rows.
13. Bus-created and bus-retrieved row ids are tracked and deleted with ordinary id-based deletes
    when the step row is persisted.
14. Cleanup does not require a delete-by-index/range DB API.
15. Completed step replay does not execute callback and does not emit/register messages.
16. Bus transaction errors do not fail the workflow step.
17. Schema exposes the direction-oriented indexes:
    `idx_workflow_step_emission_instance_run_direction_createdAt` and
    `idx_workflow_step_emission_instance_run_step_direction_epoch_sequence`.

Pi tests:

1. Agent events are emitted via outbound step messages instead of live state.
2. `/sessions/:id/events` can stream outbound payloads by polling DB rows directly/internal helper
   query, without a public `public emission-listing(...)` workflow service.
3. Same-process notifier wakes the route without waiting for fallback polling.
4. The route tracks outbound cursors per `stepKey + epoch`, not a single `afterSequence` cursor.
5. Rows disappear after step completion, and final snapshot still comes from workflow history.
6. `abort` / `steer` no longer depend on in-memory live controllers.
7. Later, when `abort` / `steer` use `sendStepMessage(...)`, a command is delivered to every active
   step bus epoch.

## Known limitations accepted for minimal pass

- `tx.emit` is not durable at call time.
- A process crash can drop buffered outbound messages.
- A process crash after flushing but before step persistence can leave stale rows. The next
  execution's `step-started` control row creates a new epoch so readers ignore stale rows from older
  epochs.
- Concurrent duplicate runners may interleave messages or compete on sequence assignment. The unique
  sequence index and retry reduce corruption, but this does not fully solve duplicate execution
  semantics. Existing workflow OCC still determines the real step result.
- Cross-instance `abort` / `steer` requires the later `sendStepMessage(...)` route wiring plus
  `tx.onMessage(...)` usage in Pi's agent step.
