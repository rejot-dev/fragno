# Workflow-backed Pi AgentHarness plan

## Goal

Replace the all-in-one `runPiHarnessStep` with a small workflow adapter around Pi's existing
`Session` and `AgentHarness` abstractions.

Workflow authors should use Pi normally. They should not need to understand the session-entry
journal, compact progress protocol, retry epochs, deterministic entry allocation, or operation
completion recovery.

The adapter must:

- reconstruct a Pi session from earlier workflow-step results and the current step's previous
  emissions;
- connect a real `AgentHarness` to a workflow transaction;
- skip the provider call when the current operation was already completed before a crash;
- emit live progress and durable session entries;
- return a delta that can be applied before the next workflow step;
- work without the Pi session table or `tx.mutate`.

This is primarily a refactor of existing behavior. Production LoC should remain unchanged or
decrease.

## User-facing API

The workflow author should only deal with four concepts:

1. workflow-backed session state carried between durable steps;
2. a restored Pi `Session`;
3. a normal Pi `AgentHarness`;
4. one function that connects the harness to the workflow transaction.

```ts
let state = createPiHarnessSessionState({
  metadata: {
    id: event.instanceId,
    createdAt: event.timestamp.toISOString(),
  },
  initialMessages,
});

const classification = await step.do("classify", async (tx) => {
  const { options: restoredOptions, ...workflowSession } = restoreWorkflowBackedSession({
    operationId: `${event.instanceId}:classify`,
    state,
    previousEmissions: await tx.previousEmissions(),
    models: harnessOptions.models,
  });

  const harness = new AgentHarness({
    ...harnessOptions,
    ...restoredOptions,
  });

  harness.on("tool_result", (event) =>
    event.toolName === "submitClassification" ? { terminate: true } : undefined,
  );

  return await withWorkflowAgentHarness(workflowSession, harness, tx, () =>
    harness.prompt("Classify the incoming request."),
  );
});

state = applyWorkflowAgentHarnessStepResult(state, classification);
```

The next operation uses the same pattern and receives the context and mutable Pi selections produced
by classification:

```ts
const summary = await step.do("summarize", async (tx) => {
  const { options: restoredOptions, ...workflowSession } = restoreWorkflowBackedSession({
    operationId: `${event.instanceId}:summarize`,
    state,
    previousEmissions: await tx.previousEmissions(),
    models: harnessOptions.models,
  });

  const harness = new AgentHarness({
    ...harnessOptions,
    ...restoredOptions,
  });

  return await withWorkflowAgentHarness(workflowSession, harness, tx, () =>
    harness.prompt("Summarize the classification."),
  );
});

state = applyWorkflowAgentHarnessStepResult(state, summary);
```

## Stay true to Pi

The public execution API remains Pi's `AgentHarness`:

```ts
harness.prompt(...);
harness.skill(...);
harness.promptFromTemplate(...);
harness.compact(...);
harness.navigateTree(...);

harness.on(...);
harness.subscribe(...);
harness.abort();
harness.steer(...);
harness.followUp(...);
harness.nextTurn(...);
```

The workflow adapter must not provide a parallel invocation API.

Remove these public concepts:

- `PiHarnessOperation` containing serialized method arguments;
- `runPiHarnessOperation`, which dispatches back to AgentHarness methods;
- `PiHarnessExecution`, which merely renames Pi's session and harness objects;
- `applyPiHarnessOperationPolicy` for behavior already expressible with `harness.on(...)`;
- the optional result bag containing `assistantMessage`, `compactResult`, and `navigateTreeResult`
  together.

The adapter does not require a parallel `method` or operation descriptor. The direct callback return
value is checkpointed in the completion emission, while interrupted attempts are classified from
their emitted session entries.

## `restoreWorkflowBackedSession`

```ts
function restoreWorkflowBackedSession(options: {
  operationId: string;
  state: PiHarnessSessionStepState;
  previousEmissions: readonly WorkflowStepEmission[];
  models: Models;
}): RestoredWorkflowBackedSession;
```

The result explicitly contains the real Pi `Session`, its workflow-aware storage, and the restored
AgentHarness option overrides consumed by `withWorkflowAgentHarness`:

```ts
type RestoredWorkflowBackedSession = {
  session: Session;
  storage: WorkflowAgentHarnessStorage;
  options: {
    session: Session;
    model?: Model;
    thinkingLevel?: ThinkingLevel;
    activeToolNames?: string[];
  };
};

class WorkflowAgentHarnessStorage extends WorkflowBackedSessionStorage {
  readonly workflowMetadata: {
    operationId: string;
    persistedEntryIds: ReadonlySet<string>;
    recovery: WorkflowAgentHarnessRecovery;
  };

  subscribeToAppendedEntries(listener: AppendEntryListener): () => void;
}
```

The returned `options` are spread after normal runtime defaults so selections recovered from the
active session branch take precedence. Model and tool implementations remain runtime dependencies;
model, thinking-level, and active-tool identities remain durable session facts.

Responsibilities:

- establish the workflow-emission payload type at this boundary;
- merge entries committed by earlier workflow steps with entries emitted by interrupted attempts of
  the current step;
- recover the latest operation-complete checkpoint;
- reject interrupted callbacks that did not emit an identifiable initial user message;
- select the parent leaf used when retrying an interrupted prompt-like callback;
- calculate the next deterministic session-entry index;
- construct `WorkflowAgentHarnessStorage` and Pi's `Session`;
- expose operation recovery metadata and append subscriptions through the concrete storage.

The function does not emit, subscribe, invoke the provider, or call transaction mutation APIs.

The pure reconstruction calculations should be extracted as private semantic functions. The public
function is their small assembly boundary.

## `withWorkflowAgentHarness`

```ts
function withWorkflowAgentHarness<TResult>(
  workflowSession: WorkflowAgentHarnessContext,
  harness: AgentHarness,
  tx: Pick<WorkflowStepTx, "emit">,
  runDurableStep: () => Promise<TResult>,
): Promise<WorkflowAgentHarnessStepResult<TResult>>;
```

The narrow transaction contract requires only `emit`. It does not require `mutate`, schema access,
or Pi-specific hooks. An actual workflow transaction satisfies the contract directly.

`withWorkflowAgentHarness(...)` handles all workflow plumbing:

1. If an operation-complete checkpoint exists, return its exact result without invoking `invoke`.
2. Subscribe to workflow-backed storage appends and emit session-entry records.
3. Subscribe to AgentHarness events and emit compact progress records.
4. Emit operation start.
5. Move to the retry parent leaf when required.
6. Invoke the callback exactly once for the active attempt.
7. Read the resulting session entries and leaf.
8. Build the delta-only durable result.
9. Emit operation completion.
10. Remove subscriptions in `finally`.

A terminal assistant without an operation-complete checkpoint is retried. The adapter cannot safely
synthesize an arbitrary callback result because the callback may transform the Pi method's return
value.

The callback contains a normal Pi method call:

```ts
withWorkflowAgentHarness(workflowSession, harness, tx, () => harness.prompt("Hello"));
withWorkflowAgentHarness(workflowSession, harness, tx, () => harness.skill("review"));
withWorkflowAgentHarness(workflowSession, harness, tx, () => harness.compact());
```

The callback's return type is preserved in the durable result:

```ts
type WorkflowAgentHarnessStepResult<TResult> = {
  type: "harness-run";
  value: TResult;
  appendedEntries: SessionTreeEntry[];
  leafId: string | null;
};
```

## `applyWorkflowAgentHarnessStepResult`

```ts
function applyWorkflowAgentHarnessStepResult(
  state: PiHarnessSessionStepState,
  result: Pick<WorkflowAgentHarnessStepResult, "appendedEntries" | "leafId">,
): PiHarnessSessionStepState;
```

This pure reducer:

- merges `appendedEntries` by entry ID;
- validates that the result leaf is derivable from the merged entries;
- records entry IDs represented by completed durable step results;
- carries stable session metadata unchanged.

It is the one canonical implementation; the duplicate merge from the removed loop adapter is gone.

The result remains delta-only. Returning the complete session state from every workflow step would
make workflow history grow quadratically.

## Optional Pi integrations

### Interactive controls

Interactive workflows can continue to install control handling around the real harness:

```ts
tx.onEvent("command", async (event) => {
  // Parse at the workflow-event boundary, then call harness.abort(),
  // harness.steer(), harness.followUp(), or harness.nextTurn().
});
```

This does not belong in the generic workflow connection. Autonomous workflows should not subscribe
to Pi session commands.

### Operation-completed durable hook

The existing Pi `onOperationCompleted` integration becomes an optional completion observer supplied
by the workflow author or the interactive Pi workflow.

The generic connection invokes `onTerminalOutcome` with the invocation's exact session entries
before validating a failed terminal assistant or emitting the completion checkpoint. The observer
may run more than once before the enclosing workflow step commits, so it must only declare
replay-safe durable work.

The optional Pi adapter passes those entries to `schedulePiOperationCompletedHook`, which translates
them into `PiOperationCompletedHookPayload` and registers both `tx.mutate` and the
`tx.onTerminalError.mutate` fallback. The workflow transaction commits only the applicable path.

Remote and codemode workflows omit this observer, so they never touch unsupported transaction
features.

## Constraints

### Public API constraints

- Users call methods directly on Pi's `AgentHarness`.
- The adapter does not own `step.do(...)`; the workflow author chooses step names and boundaries.
- The adapter does not create or read Pi session-table rows.
- The generic adapter does not import `piSchema`, Pi route types, or Pi command payloads.
- The generic transaction contract does not include `tx.mutate`.
- Recovery metadata is explicit and readonly on `WorkflowAgentHarnessStorage`; users pass the
  restored context through rather than rewriting replay entries, epochs, or entry indexes.
- One `withWorkflowAgentHarness(...)` call represents one top-level durable AgentHarness invocation.
- A Pi operation may contain multiple model turns and tool calls internally.
- The invocation callback must return a workflow-serializable value.
- Do not invoke session-mutating AgentHarness methods before `withWorkflowAgentHarness(...)` has
  installed its subscriptions.

### Durability constraints

- `operationId` must be stable across retries and unique within the logical workflow session.
- `previousEmissions` must come from the current workflow step's previous attempts.
- Cross-step context must come from `PiHarnessSessionStepState`, not by scanning unrelated workflow
  history inside the adapter.
- Session-entry IDs must remain deterministic and must not be reused after interrupted attempts.
- Completed-operation recovery must not invoke the provider again.
- Terminal assistant recovery must emit the missing completion journal before returning.
- Partial prompt-like operations may retry only after restoring the parent of the original prompt.
- Partial non-prompt operations remain rejected unless a method-specific safe recovery rule exists.
- Tool side effects are not exactly once. A crash after a tool result but before terminal completion
  may cause the tool to run again. The API must not claim stronger guarantees.

### Scope and size constraints

- Keep the existing emission protocol in this refactor.
- Extract existing blocks instead of building parallel implementations.
- Do not add a plugin framework or generic event bus.
- Do not retain `runPiHarnessStep` as a compatibility wrapper after callers migrate.
- Do not introduce forwarding modules or deprecated aliases.
- Keep pure helpers private unless another real caller needs them.
- Production LoC must remain unchanged or decrease after deleting the dispatcher, duplicate merge,
  embedded Pi hooks, and command-control wiring.

## Why this works

### Context survives across workflow steps

Each completed operation returns only newly durable `SessionTreeEntry` values. The workflow applies
that delta to `PiHarnessSessionStepState` before constructing the next Pi session. Replaying
completed workflow steps returns the same deltas, so the same session tree is reconstructed after
worker restart.

Pi already treats `Session` as the source of conversation and tree context. Reconstructing Pi's own
session representation means `AgentHarness` receives the same context without a parallel message
model.

### Interrupted operations can recover safely

Session entries and operation journals are emitted while the provider operation is running. If the
worker crashes after the provider finishes but before the workflow step commits, the next attempt
sees those previous emissions.

The restore stage can then:

- return the recorded completion directly;
- synthesize completion from a terminal assistant entry;
- or roll an interrupted prompt-like operation back to its original parent and retry.

This preserves the existing provider-deduplication behavior without requiring a database session
row.

### Live progress remains available

The connection subscribes before invoking the callback. Every appended session entry and
AgentHarness event is converted into the existing workflow emission protocol. Current client
projections continue to combine committed step results with in-flight emissions.

### Remote workflows are supported

The generic connection only needs emission and event capabilities available to remote workflow
transactions. Pi accounting is an optional outer adapter, so codemode automations do not call
unsupported `tx.mutate` APIs.

### The API follows Pi instead of wrapping it

The user constructs a real `AgentHarness`, receives a real `Session`, and invokes real AgentHarness
methods. New Pi methods and event handlers do not require adding arguments to a custom operation
union or extending a dispatcher before users can access them.

Only the recovery `method` metadata may need extension when a new Pi method requires a distinct
retry policy. Invocation itself remains unchanged.

### The implementation becomes smaller

Most of `runPiHarnessStep` already implements restoration, connection, and result reduction. The
refactor moves those blocks behind the new boundaries and deletes:

- the operation argument union;
- the operation dispatcher;
- duplicate session-entry merging;
- generic-path Pi hook construction;
- generic-path command handling;
- the final all-in-one wrapper.

The user-facing shell becomes smaller while the difficult recovery calculations become focused,
testable semantic functions.

## Implementation sequence

1. [x] Extract and test the session-entry merge and workflow-state reducer.
2. [x] Implement completed-checkpoint replay, interrupted-prompt rollback, and deterministic entry
       allocation behind `restoreWorkflowBackedSession`.
3. [x] Make `WorkflowBackedSessionStorage` append observation connectable before invocation.
4. [x] Implement `withWorkflowAgentHarness(...)` with direct callbacks, typed checkpoint values,
       progress bridging, and cleanup.
5. [x] Restore durable model, thinking-level, and active-tool selections when constructing a
       harness.
6. [x] Keep interactive command handling in the interactive workflow.
7. [x] Move Pi completion-hook scheduling into an optional Pi-specific outer integration.
8. [x] Replace the loop adapter with restored sessions and direct `AgentHarness` calls.
9. [x] Migrate autonomous and Backoffice workflow callers.
10. [x] Remove `runPiHarnessStep`, its dispatcher, old option types, and remaining duplicate
        helpers.

## Tests

- Pure restoration tests cover completed checkpoints, exact generic result replay, terminal
  assistant retry, prompt rollback, unsafe partial callbacks, and deterministic entry indexes.
- Connection tests use a concrete workflow transaction and concrete WorkflowBackedSessionStorage.
- Existing retry tests continue to prove that recovered completion does not invoke the provider.
- Existing progress tests continue to prove compact message updates and tool-event streaming.
- Multi-step tests call real `harness.prompt(...)` operations and apply returned deltas between
  workflow steps.
- Remote workflow coverage verifies operation without `tx.mutate`.
- Interactive tests verify commands still call the real harness controls.
- Pi adapter tests verify operation-completed hooks retain their existing transactional semantics.
- Existing duplicate-tool-side-effect coverage remains and documents the durability limit.

## Acceptance criteria

- The normal workflow call site matches the user-facing example above.
- Users directly call Pi `AgentHarness` methods.
- Users do not manually emit session entries, progress events, operation starts, or operation
  completions.
- Multiple durable workflow steps share reconstructed Pi session context.
- Completed operations recover without invoking the provider again.
- Live projections continue to receive the existing emission protocol.
- The generic adapter works in remote workflows without `tx.mutate`.
- Interactive Pi sessions retain controls and accounting through optional outer adapters.
- No Pi session-table row is needed for agent context.
- Production LoC is unchanged or reduced.
