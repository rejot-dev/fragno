# Rules

- `tick()` must use exactly one `handlerTx` call.
- All reads happen in that single retrieve phase; all writes are scheduled inside the same
  transaction.
- OCC is the only coordination mechanism (no task claiming or leases).
- `onAfterRetrieve` must be used for planning because transform hooks are synchronous and run too
  late.

# New Runner Progress

## What We Did

- Added `packages/fragment-workflows/src/new-runner.ts` as the scaffold for a single-transaction
  runner.
- Enforced the "one `handlerTx` per tick" rule by doing all reads in one retrieve phase and planning
  all writes inside `onAfterRetrieve`.
- Removed helper wrappers (`runHandlerTxForRunner`, `runHandlerTx`) and used `fragment.inContext`
  directly.
- Documented why `onAfterRetrieve` is used instead of transform hooks (transforms are sync and too
  late).
- Converted top-level helper declarations to `function` and added JSDoc.
- Added step/event prefetch in the same retrieve call.
- Built in-memory indexes for steps/events by `instanceRef`.
- Expanded `WorkflowEnqueuedHookPayload` to include `instanceRef` and `runNumber`, and changed
  runner tick signature to accept the payload.
- Updated `onWorkflowEnqueued` to pass the payload through to `runner.tick(...)`.
- Updated all `triggerHook("onWorkflowEnqueued", ...)` call sites to include `instanceRef` and
  `runNumber`.
- Removed the manual `/_runner/tick` route and its client stub.
- Reworked `tick()` to be instance-scoped and DB-time filtered (pending + expired processing) using
  new indexes:
  - `idx_workflow_task_instanceRef_runNumber_status_runAt`
  - `idx_workflow_task_instanceRef_runNumber_status_lockedUntil`
- Removed `maxInstances`/`maxSteps` caps and truncation/missing-history logic; steps/events are now
  fully fetched per instance.
- Removed `RunnerTickOptions` (tick takes only the hook payload).
- Removed authorize hook config/options and tests; rely on middleware instead.
- Added `packages/fragment-workflows/src/runner/state.ts` with a minimal in-memory runner state +
  mutation buffer.
- Wired `new-runner.ts` to build runner state per runnable task using retrieved
  instance/steps/events (no runNumber filtering; queries are already scoped).
- Dropped workflow tasks/logs entirely and made the runner hook-driven (no leases/locking).
- Added a minimal `RunnerStep` + `RunnerState` + mutation buffer, and wired `runTask` +
  `applyRunnerMutations` + `applyOutcome`.
- Removed step/event truncation and always fetch full history for the run.
- Hook metadata (`hookId`, `status`, `attempts`, `createdAt`, `nextRetryAt`, etc.) is now available
  in `HookContext`.
- Enqueue hook now forwards a timestamp from hook metadata into `runner.tick`.

## Current Implementation (Pre-Pivot)

## Current Implementation

- `tick()` is instance-scoped and runs exactly one `handlerTx` with a single retrieve for instance +
  steps + events.
- A plan is built inside `onAfterRetrieve`, then mutations are scheduled before `executeMutations`.
- Workflow execution happens via `RunnerStep`, which buffers step/event writes and user mutations.
- Outcomes update `workflow_instance` and schedule follow-up hooks via `processAt`.

## Decision: Hook-Only, Instance-Scoped Ticks

- Drop the manual `/_runner/tick` endpoint. The only trigger path will be durable hooks.
- Expand the durable hook payload so it contains the data needed to run exactly one instance:
  `instanceRef`, `runNumber`, `workflowName`, `instanceId`, `reason`.
- The runner will only fetch data for the single instance referenced by the hook: instance, task(s)
  for that run, steps for that run, events for that run.
- This avoids global overfetch and aligns with durable hook scheduling (sleep/wake).

## Risks / Notes

- Long-running hooks can be re-queued if they exceed `stuckProcessingTimeoutMinutes`, which can
  cause duplicate hooks and extra OCC conflicts.
- TODO (long-term): define max workflow execution time and align hook timeout.
- Stranded tasks are possible if a task exists without a hook event; we accept this for now but must
  remain aware.
- Concurrency/duplicates: we plan to add a hook key / upsert semantics in `fragno-db` so duplicate
  enqueue events collapse. We still need to reason about OCC and concurrent dispatchers.
- No lease recovery scan: if we keep `processing` tasks and remove any global scan, stalled tasks
  may never be recovered. The new runner should either avoid `processing` entirely or schedule a
  hook at `lockedUntil` when it writes a lease.

## Review gaps to address (new runner vs old runner):

- Retry/sleep/waitForEvent replays do not respect persisted `nextRetryAt`/`wakeAt`, which can extend
  waits or execute early.
- Step keys now use `type:name` with no migration; existing `name`-keyed steps will re-run.

## Current Status

- Runner is end-to-end for hook-driven ticks: instance/steps/events retrieved once, workflow
  executed, mutations applied, outcome scheduled.
- No workflow_task/workflow_log tables; locking/leasing removed.
- Hook metadata is available in `HookContext`, and enqueue hook forwards a timestamp to
  `runner.tick`.

## Up Next

## Recently Completed

- Make hook timestamp required end-to-end (no fallback to instance timestamps), and update any
  direct `tick` call sites/tests.
- Add runner-focused tests for retry/sleep/waitForEvent/timeouts/error cases.
- Remove `step.do` timeout support (timeouts now only apply to `waitForEvent`).
- Enforce `waitForEvent` timeout deadlines when consuming events.
- Define `NonRetryableError` semantics (no retries) and add coverage.
- Treat mutation-phase errors as non-retryable and mark instances errored via a follow-up tick.
- Honor `pauseRequested`/`waitingForPause` during ticks by short-circuiting to `paused`, and skip
  scheduling wake/retry hooks when a suspended outcome is paused (pauseRequested remains sticky).

## Up Next

1. Decide whether to add an explicit “running” transition (status is currently unused).
2. Ensure replay respects persisted `wakeAt`/`nextRetryAt` (no extending waits or early retries).
3. Decide on step key migration strategy (`type:name` vs legacy `name`) and document it.
