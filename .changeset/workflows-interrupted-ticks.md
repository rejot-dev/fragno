---
"@fragno-dev/workflows": minor
---

feat!: remote workflow hosts can call `interruptTick(cause)` on their `RemoteWorkflowStepHost` when
a tick could not run where they sent it, such as to an unreachable executor. The runner discards the
attempt in progress, keeps completed steps, and runs the tick again after a delay drawn from the
upper half of a backoff that starts at 30 seconds and doubles up to 10 minutes; the eighth
interrupted tick in a row errors the instance, and any other outcome resets the count. Workflows not
defined as remote cannot interrupt their tick, and catching the thrown error does not undo the
report. Custom `RemoteWorkflowStepHost` implementations must add `interruptTick`.
`workflow_instance` gains an `interruptedTicks` column, so run your schema migrations. Scenarios
gain `runner.advanceTimeAndDrainHooks`, which lets due durable hooks drive ticks with their stored
payloads.
