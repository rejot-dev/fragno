# Minimal plan: read-side winner filtering, no losing-emission cleanup

## 1. Make execution identity durable

Modify the base schema directly in `packages/fragment-workflows/src/schema.ts`.

No migration or nullable compatibility fields.

```ts
workflow_step_emission.executionId: string // non-nullable
workflow_step.committedByExecutionId: string // non-nullable
```

Existing databases must be recreated.

Semantics:

- `executionId`: one speculative handler-transaction attempt.
- `committedByExecutionId`: the execution whose transaction most recently committed this step state.

## 2. Generate one ID per transaction attempt

In `runWorkflowsTick()`, generate the ID inside `onAfterRetrieve`, because that callback reruns for
every automatic `handlerTx` retry.

```ts
onAfterRetrieve: async (uow, results) => {
  const executionId = createExecutionId();
  // Build this attempt's plan.
};
```

Add:

```ts
createExecutionId?: () => string;
```

for deterministic tests.

Attempt-local state must also be reset inside this callback:

```ts
processed;
stepEmissionsToPublish;
executionId;
```

Do not reuse an ID across automatic transaction retries.

## 3. Propagate the execution ID

Pass `executionId` through:

```text
runWorkflowsTick
  → RunnerTickContext
  → RunnerStep
  → WorkflowStepEmissionScope
  → workflow_step_emission
```

Every emission row receives it, including:

- `step-started`;
- `event-consumed`;
- user progress;
- `step-committed`.

Per-step `epoch` remains separate.

Example:

```text
execution A
  prompt epoch A1
  wait epoch A2

execution B
  prompt epoch B1
  speculative steer epoch B2
```

## 4. Atomically mark the winner

Pass `executionId` into `applyRunnerMutations()`.

Whenever a workflow step is created or updated, set:

```ts
committedByExecutionId: executionId;
```

This write happens in the same transaction as:

- step result creation/update;
- workflow-event consumption;
- instance status changes;
- durable hooks;
- `step-committed` emissions.

For a race:

```text
A commits the step:
  workflow_step.committedByExecutionId = A

B attempts the same step:
  unique constraint fails
  B's workflow transaction rolls back
```

The durable step row proves that A won.

## 5. Add generic canonical filtering

Create one generic workflow helper, for example:

```ts
selectCanonicalWorkflowStepEmissions({
  steps,
  emissions,
}): WorkflowStepEmission[]
```

### Determine proven noncanonical executions

Only terminal step states establish a winner:

```ts
const terminalSteps = steps.filter(
  (step) => step.status === "completed" || step.status === "errored",
);
```

Do not use waiting steps: a later execution is legitimately allowed to resume them.

For every terminal step:

```ts
const winner = step.committedByExecutionId;
```

Any other execution that emitted against that same step key is proven noncanonical:

```ts
for (const emission of emissions) {
  const step = terminalStepsByKey.get(emission.stepKey);

  if (step && emission.executionId !== step.committedByExecutionId) {
    noncanonicalExecutionIds.add(emission.executionId);
  }
}
```

Then remove every emission from those executions:

```ts
return emissions.filter((emission) => !noncanonicalExecutionIds.has(emission.executionId));
```

This is the cross-step behavior needed for the Pi race:

```text
B1 competed against A1 and lost
B1.executionId === B2.executionId
therefore both B1 and B2 are excluded
```

### Before a winner exists

If no terminal step proves that an execution lost, retain its emissions.

Do not implement latest-start-wins.

## 6. Apply filtering at every logical read boundary

Use the generic selector before interpreting emissions in:

1. **Runner restoration**
   - `previousEmissions()`
   - `previousConsumedEvents()`

2. **Live-pump event delivery**
   - exclude `event-consumed` markers from proven noncanonical executions;
   - only canonical consumption markers suppress workflow events.

3. **Generic workflow clients**
   - current-step emission projections;
   - execution-activity projections.

4. **Pi server projection**
   - session detail;
   - transcript projection;
   - draft/tool activity.

5. **Remote workflow reconstruction**
   - ensure forwarded previous emissions and consumed events are already canonical.

Keep raw database/scenario inspection APIs raw where useful for diagnostics.

### Keep step-scoped recovery helpers

`#previousEmissionsFor()` and `#previousConsumedEventsFor()` remain necessary because they solve
problems separate from cross-execution winner filtering.

Canonicalize emissions once before constructing `RunnerState`:

```ts
const canonicalEmissions = selectCanonicalWorkflowStepEmissions({
  steps,
  emissions,
});

const state = createRunnerState(instance, steps, events, canonicalEmissions);
```

The processing order is:

```text
raw emissions
  → remove proven noncanonical executions
  → construct RunnerState with canonical emissions
  → apply step-scoped recovery behavior
```

The responsibilities remain distinct:

```text
selectCanonicalWorkflowStepEmissions
  → cross-execution winner filtering

#previousEmissionsFor
  → select one step key and one coherent replay epoch

#previousConsumedEventsFor
  → reconstruct original consumed events from canonical acknowledgement markers
```

`#previousEmissionsFor()` still selects the requested `stepKey`, chooses one replay epoch when no
durable winner exists, and converts stored rows into the public `WorkflowStepEmission` shape. Replay
source selection does not establish ownership.

`#previousConsumedEventsFor()` still joins canonical `event-consumed` markers back to their original
`workflow_event` records, deduplicates them, restores original event ordering and payloads, and
reports missing referenced events.

Both public APIs remain part of the workflow recovery contract.

## 7. Remove losing-execution cleanup

Delete:

```ts
cleanupLosingExecutionEmissions();
```

Also remove:

- `executionEpochs`;
- the epoch-collection wrapper used only by cleanup;
- the cleanup call in the concurrency-conflict handler.

Keep unique workflow-step constraint classification:

```ts
if (isWorkflowStepUniqueConstraintError(error)) {
  return 0;
}
```

The losing emissions remain physically stored but are logically invisible.

The existing successful-step emission cleanup hook may remain. Durable winner identity now lives on
`workflow_step`, not in an ephemeral `step-committed` row.

## 8. Required tests

### Generic selector

- Both attempts visible before a winner exists.
- Older execution commits first.
- Newer execution commits first.
- Losing downstream step emissions are excluded.
- A waiting step does not reject a legitimate resuming execution.
- Terminal `errored` steps also establish canonical execution.
- Unrelated later executions remain visible.

### Runner integration

- Every emission from one transaction attempt shares an execution ID.
- A transaction retry receives a different execution ID.
- The successful step contains the successful attempt’s ID.
- Losing emissions remain physically present after the conflict.
- Canonical reads exclude them.
- Losing `event-consumed` markers do not suppress delivery.
- `previousEmissions()` excludes losing executions.
- `previousConsumedEvents()` excludes losing acknowledgements.

### Pi scenarios

Run the cleanup-disabled scenarios unchanged:

- queued steering recovery;
- post-append steering recovery;
- ordered multiple steering;
- terminal-assistant/tool recovery.

They must pass while raw workflow storage still contains the losing execution’s emissions.
