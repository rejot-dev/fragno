# Pi workflow AgentHarness status

`workflow-agent-harness.ts` is the only durable Pi execution adapter. Workflow authors own
`step.do(...)`, restore a real Pi `Session`, construct a real `AgentHarness`, invoke the desired Pi
method through `withWorkflowAgentHarness(...)`, and fold the completed result into workflow-local
state with `applyWorkflowAgentHarnessStepResult(...)`.

The removed loop and step-runner adapters are not compatibility targets. This document records the
current contract and remaining coverage gaps rather than comparing against those implementations.

## Current contract

| Capability                                           | Status                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Canonical conversation state                         | Workflow step results and emissions; no Pi session table                                      |
| Session identity and metadata                        | Workflow instance identity plus `params.__piSession` and optional `params.metadata`           |
| Prompt, image, skill, and prompt-template operations | Implemented and scenario-tested                                                               |
| Direct tools and active-tool selection               | Implemented and scenario-tested                                                               |
| Model, thinking-level, and active-tool restoration   | Implemented and restart-tested                                                                |
| In-flight prompt recovery                            | Restores from durable emissions without duplicating the logical prompt                        |
| Completed callback replay                            | Replays the exact checkpointed callback value                                                 |
| Missing completion checkpoint                        | Retries because an arbitrary callback result cannot be reconstructed safely                   |
| Failed assistant                                     | Observed and accounted before rejection; no completion checkpoint                             |
| Abort, steer, and follow-up controls                 | Active-operation behavior is scenario-tested                                                  |
| Idle controls                                        | Consumed and ignored; a new turn uses `prompt`                                                |
| Event delivery                                       | At-least-once; handlers and terminal observers must be replay-safe                            |
| Concurrent attempts                                  | First durable completion wins; losing emissions are excluded from canonical reads             |
| Operation accounting                                 | Explicitly composed with `schedulePiOperationCompletedHook(...)`; interactive chat enables it |
| Session projection                                   | Reconstructs committed messages and provisional live activity from workflow records           |
| JSONL export                                         | Reconstructs Pi session entries from workflow history                                         |
| Wait-for-agent-end route                             | Observes canonical workflow emissions                                                         |
| Compact                                              | Supported by direct `AgentHarness` access; workflow-backed scenario coverage remains          |
| Navigate tree                                        | Supported by direct `AgentHarness` access; restart and leaf-restoration coverage remains      |

## Durable execution shape

```ts
const result = await step.do(stepName, async (tx) => {
  const {
    session,
    storage,
    options: restoredOptions,
  } = restoreWorkflowBackedSession({
    operationId,
    state,
    previousEmissions: await tx.previousEmissions(),
    models,
  });
  const harness = new AgentHarness({ models, model, ...restoredOptions });

  return await withWorkflowAgentHarness({
    session,
    storage,
    harness,
    tx,
    runDurableStep: () => harness.prompt(text),
  });
});

state = applyWorkflowAgentHarnessStepResult(state, result);
```

Workflow state is immutable across reductions, so workflows spanning multiple operations must keep a
mutable local accumulator and assign each reduced result back to it.

## Recovery and concurrency guarantees

Only a successful durable completion checkpoint proves that an arbitrary callback result exists.
Provider calls and tool executions can physically repeat before a workflow-step transaction commits.
The workflow runtime guarantees one canonical logical completion, not exactly-once external side
effects.

Overlapping attempts remain candidates until one commits. The workflow-step uniqueness constraint
selects the winner, and canonical emission selection follows that committed execution. Tools with
external effects should use an idempotency key such as `operationId + toolCallId` or perform their
own reconciliation.

`onTerminalOutcome` and workflow event handlers are at-least-once observers. Accounting hooks and
other effects scheduled from them must therefore be replay-safe.

## Remaining verification work

1. Add workflow-backed `compact()` scenarios.
2. Add `navigateTree()` scenarios, including restart leaf restoration.
3. Restore compile-time coverage for typed tool-result `message.details`.
4. Add a true process-crash test primitive to distinguish sequential crash recovery from overlapping
   stale-worker recovery.

The current restart scenarios intentionally model overlapping workers because the test harness
cannot terminate an active JavaScript callback. SQLite uniqueness diagnostics can therefore appear
while the runtime selects the durable winner.
