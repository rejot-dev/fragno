# Rules
- `tick()` must use exactly one `handlerTx` call.
- All reads happen in that single retrieve phase; all writes are scheduled inside the same transaction.
- OCC is the only coordination mechanism (no task claiming or leases).
- `onAfterRetrieve` must be used for planning because transform hooks are synchronous and run too late.

# New Runner Progress

## What We Did
- Added `packages/fragment-workflows/src/new-runner.ts` as the scaffold for a single-transaction runner.
- Enforced the "one `handlerTx` per tick" rule by doing all reads in one retrieve phase and planning all writes inside `onAfterRetrieve`.
- Removed helper wrappers (`runHandlerTxForRunner`, `runHandlerTx`) and used `fragment.inContext` directly.
- Documented why `onAfterRetrieve` is used instead of transform hooks (transforms are sync and too late).
- Converted top-level helper declarations to `function` and added JSDoc.
- Added step/event prefetch in the same retrieve call.
- Built in-memory indexes for steps/events by `instanceRef`.
- Added notes on `maxInstances`/`maxSteps` implications in code.

## Current Implementation (Pre-Pivot)
- `tick()` currently reads pending + expired tasks with instance join, plus global step/event history bounded by `maxInstances * maxSteps`.
- It builds a selection snapshot and then a tick plan inside `onAfterRetrieve`.
- It schedules all mutations via the UOW before `executeMutations` runs.
- It skips tasks if step/event history looks truncated because global prefetch can starve other instances.

## Decision: Hook-Only, Instance-Scoped Ticks
- Drop the manual `/_runner/tick` endpoint. The only trigger path will be durable hooks.
- Expand the durable hook payload so it contains the data needed to run exactly one instance: `instanceRef`, `runNumber`, `workflowName`, `instanceId`, `reason`.
- The runner will only fetch data for the single instance referenced by the hook: instance, task(s) for that run, steps for that run, events for that run.
- This avoids global overfetch and aligns with durable hook scheduling (sleep/wake).

## Risks / Notes
- Long-running hooks can be re-queued if they exceed `stuckProcessingTimeoutMinutes`, which can cause duplicate hooks and extra OCC conflicts.
- TODO (long-term): define max workflow execution time and align hook timeout.
- Stranded tasks are possible if a task exists without a hook event; we accept this for now but must remain aware.
- Concurrency/duplicates: we plan to add a hook key / upsert semantics in `fragno-db` so duplicate enqueue events collapse. We still need to reason about OCC and concurrent dispatchers.
- No lease recovery scan: if we keep `processing` tasks and remove any global scan, stalled tasks may never be recovered. The new runner should either avoid `processing` entirely or schedule a hook at `lockedUntil` when it writes a lease.

## Next Steps
1. Update `WorkflowEnqueuedHookPayload` to include `instanceRef` and `runNumber`.
2. Update all `triggerHook("onWorkflowEnqueued", ...)` call sites to include the new payload fields.
3. Remove the manual tick endpoint and any `enableRunnerTick` gating or tests that rely on it.
4. Rework `new-runner.ts` to be instance-scoped: retrieve instance, tasks, steps, and events for the single instance/run referenced by the hook payload.
5. Wire workflow execution in the new runner: create `RunnerState`/`RunnerStep`, run workflow code, and convert buffered mutations into UOW operations in the same transaction.
6. Implement task completion/reschedule logic in the new runner: delete tasks on completion/error, schedule next task on suspend (wake/retry), and trigger hooks with `processAt` using the new payload.
7. Align hook scheduling semantics with the planned hook key/upsert behavior once `fragno-db` supports it.
