---
"@fragno-dev/workflows": minor
---

feat!: a step that waits for a sleep, an event, or its next retry now returns a promise that stays
pending until a later tick resumes it, instead of throwing to end the tick. A tick ends once no step
is running and the workflow code stops calling new ones. A `catch` around a step sees only how it
finally ends, and a `Promise.race` or `Promise.any` over steps keeps its winner on replay, because
replay hands settled steps back in the order they first settled (the new `settledOrder` column on
`workflow_step`).

Workflow code may now await only steps: awaiting other I/O between steps fails the run with
`WorkflowStalledError`. A `step.do` callback can no longer call steps; doing so fails the step with
`WORKFLOW_STEP_NESTED_IN_DO`, without retries.

Remote workflows run their code under the same tick driver, `createWorkflowTick` from
`@fragno-dev/workflows/workflow-tick`, in their own realm. `RemoteWorkflowStepHost` methods no
longer take a parent scope, return a `WorkflowStepCallOutcome` (settled with its settle order, or
parked) instead of throwing a suspension, and expose `settledOrders` to replay; the remote code
reports an idle tick with `reportIdle()`. `RemoteWorkflowSuspendedError` and the remote suspension
helpers are removed.
