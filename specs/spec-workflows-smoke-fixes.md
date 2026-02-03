# Workflows Reliability Fixes - Spec

## 0. Open Questions

Resolved:

- Introduce a `DbNow` **value** type (not just conditions) to emit `CURRENT_TIMESTAMP` in SQL.
- `waitForEvent` eligibility is based on **event.createdAt <= step.wakeAt** (DB time).
- Events processed late are **accepted** if they were created before the deadline.
- Late events (created after `wakeAt`) are **not** dropped in this spec; they remain unconsumed.

## 1. Overview

This spec addresses the **workflow smoke-test failures** in
`packages/fragment-workflows/workflows-smoke-artifacts/report.md`, focusing on correctness and
reliability in the workflows fragment, durable hooks dispatcher, and Postgres example app.

The fixes cover:

- Batch create requests hanging
- Stale task leases leaving pending tasks unclaimable
- Steps exceeding `maxAttempts` under concurrency
- `waitForEvent` timeouts accepting late events
- Durable hooks delayed by dispatcher clock skew
- History pagination 500s with cursor paging
- API server crash on Postgres restarts
- 500s under SERIALIZABLE isolation (no retry)

The result should be a predictable, clock-skew-tolerant, retry-safe workflow engine with working
cursor pagination and operational resilience.

## 2. Goals / Non-goals

### 2.1 Goals

1. **No request hangs**: batch create completes quickly and never blocks on runner execution.
2. **No stale leases**: pending tasks can always be claimed; leases only apply to processing tasks.
3. **Retry correctness**: step attempts must never exceed `maxAttempts`.
4. **Hard timeouts**: `waitForEvent` rejects events arriving after `wakeAt`.
5. **Clock-skew tolerance**: hooks and timeouts use database time, not process-local time.
6. **Pagination works**: cursor pagination supports multi-column indexes.
7. **DB restart resilience**: Postgres restarts do not crash the API process.
8. **SERIALIZABLE safety**: serialization errors retry rather than 500.

### 2.2 Non-goals

- Redesigning the entire runner or durable hooks system.
- Adding new external APIs beyond what is required for these fixes.
- Changing the public workflow authoring API.

## 3. References

- `packages/fragment-workflows/src/definition.ts` (hooks, createBatch, sendEvent)
- `packages/fragment-workflows/src/routes.ts` (batch create, history, runner tick)
- `packages/fragment-workflows/src/runner.ts`
- `packages/fragment-workflows/src/runner/task.ts` (claim/lease/commit/heartbeat)
- `packages/fragment-workflows/src/runner/step.ts` (`waitForEvent`, retries)
- `packages/fragment-workflows/src/schema.ts` (indexes used by pagination)
- `packages/fragment-workflows/src/runner/constants.ts` (task kind priorities)
- `packages/fragno-db/src/hooks/hooks.ts` (hook processing pipeline)
- `packages/fragno-db/src/fragments/internal-fragment.ts` (hook service queries)
- `packages/fragno-db/src/dispatchers/node/index.ts` (dispatcher polling)
- `packages/fragno-db/src/adapters/generic-sql/query/cursor-utils.ts` (cursor SQL)
- `packages/fragno-db/src/adapters/generic-sql/generic-sql-uow-executor.ts` (error mapping)
- `example-apps/wf-example/app/db/db.server.ts` (pg pool lifecycle)

## 4. Detailed Fixes

### 4.1 Runner tick must not block request paths

**Problem:** `onWorkflowEnqueued` hooks call `await runner.tick()` and hook execution is awaited by
`processHooks` inside `handlerTx` completion. This causes batch create to hang when runner execution
is slow or blocked.

**Fix:** Keep hook retry semantics intact, but move hook processing off the request path. Requests
should commit and return immediately; hook execution continues in the background and can still retry
on failure.

**Code changes:**

1. **Run `processHooks` asynchronously in `handlerTx.onAfterMutate`.**
   - File: `packages/fragno-db/src/db-fragment-definition-builder.ts`
   - Replace the awaited call with a background microtask:

   ```ts
   onAfterMutate: async (uow) => {
     if (hooksConfig) {
       queueMicrotask(() => {
         void processHooks(hooksConfig).catch((error) => {
           console.error("Durable hooks processing failed", error);
         });
       });
     }
     if (userOnAfterMutate) {
       await userOnAfterMutate(uow);
     }
   },
   ```

   - This preserves hook retry behavior because hook completion still depends on the hook function
     resolving, but the request no longer waits for it.

2. **Keep `onWorkflowEnqueued` awaiting `runner.tick()`.**
   - File: `packages/fragment-workflows/src/definition.ts`
   - No change in the hook body; it should still `await runner.tick()` so failures are recorded and
     retried by the durable hooks processor.

3. **Batch create route must handle errors consistently.**
   - File: `packages/fragment-workflows/src/routes.ts`
   - Wrap the batch create handler in `try/catch` and use `handleServiceError` (same as single
     create). This ensures errors result in a response rather than hanging.

### 4.2 Stale leases must not block pending tasks

**Problem:** `renewTaskLease` updates `lockedUntil` even when the task has already been moved to
`pending`, which leaves a pending task with an active lease. `claimTask` then treats the lease as
active and skips it.

**Fix:** Only renew leases for tasks that are still `processing` **and** owned by the current
runner. Pending tasks must ignore `lockedUntil`.

**Code changes:**

1. **Guard `renewTaskLease` by task status and lock owner.**
   - File: `packages/fragment-workflows/src/runner/task.ts`
   - After retrieve, if `currentTask.status !== "processing"` or
     `currentTask.lockOwner !== ctx.runnerId`, return `{ ok: false }` and skip the update.

2. **Ignore `lockedUntil` for `pending` tasks when claiming.**
   - File: `packages/fragment-workflows/src/runner/task.ts`
   - In `claimTask`, treat `hasActiveLease` as **false** for status `pending`.
   - This guarantees pending tasks can always be reclaimed even if `lockedUntil` is set.

3. **Stop heartbeat if lease renewal fails.**
   - File: `packages/fragment-workflows/src/runner/task.ts`
   - `startTaskLeaseHeartbeat` already stops when `renewTaskLease` returns `{ ok: false }`. Keep
     this behavior and ensure no further renewals are attempted.

### 4.3 Enforce `maxAttempts` strictly

**Problem:** Concurrent dispatchers can cause a step to run more times than configured.

**Fix:** Never execute a step if its recorded attempts already meet or exceed `maxAttempts`.

**Code changes:**

1. **Pre-run guard in `RunnerStep.do`.**
   - File: `packages/fragment-workflows/src/runner/step.ts`
   - After loading `existing` and computing `maxAttempts`, add:

   ```ts
   if (existing && existing.attempts >= maxAttempts) {
     queueStepUpdate(this.#state, name, existing.id, {
       status: "errored",
       errorName: "StepMaxAttemptsExceeded",
       errorMessage: "STEP_MAX_ATTEMPTS_EXCEEDED",
       updatedAt: now,
     });
     throw new NonRetryableError("STEP_MAX_ATTEMPTS_EXCEEDED", "StepMaxAttemptsExceeded");
   }
   ```

2. **Do not increment attempts beyond `maxAttempts`.**
   - Ensure `attempt` is only incremented when executing the step body.
   - If the guard triggers, `attempts` remains unchanged (already at max).

### 4.4 `waitForEvent` timeout is hard (deadline = event.createdAt)

**Problem:** Events created after `wakeAt` can still complete a `waitForEvent` step if processed
before the timeout tick runs.

**Fix:** Eligibility is based on **event.createdAt <= wakeAt** (DB time), not processing time. A
`waitForEvent` step must:

- **Accept** events created before `wakeAt`, even if processed after the deadline.
- **Reject** events created after `wakeAt`.

**Code changes:**

1. **Filter candidate events by deadline in `waitForEvent`.**
   - File: `packages/fragment-workflows/src/runner/step.ts`
   - Compute `wakeAt` before selecting an event.
   - Select only events with `createdAt <= wakeAt`.
   - If `wakeAt <= now`, still deliver any eligible event; only timeout if **no** eligible event
     exists.

2. **Prevent late events from waking a timed-out step.**
   - File: `packages/fragment-workflows/src/definition.ts` (`sendEvent` service)
   - Only set `shouldWake` if there is a waiting step where `waitEventType === options.type` **and**
     `wakeAt` is either `null` or in the future (`wakeAt > dbNow()`).
   - If a matching waiting step has `wakeAt <= dbNow()`, still create the event but **do not**
     enqueue a wake task and **do not** mark it delivered. The event remains unconsumed; late
     delivery is inferred from `event.createdAt > step.wakeAt` plus the step error state.

### 4.5 Database time for values **and** comparisons

**Problem:** Hook processing and workflow scheduling rely on process-local `Date`. Skewed clocks can
delay or accelerate timeouts and retries.

**Fix:** Use **database time** for both:

- **Comparisons** (e.g., `nextRetryAt <= now`)
- **Values** (e.g., `lastAttemptAt = now`, `updatedAt = now`)

**Code changes:**

1. **Introduce a DB-time value type.**
   - Add `DbNow` helper + `dbNow()` factory in `@fragno-dev/db`, modeled after the existing
     `dbSpecial: "now"` default behavior.
   - `DbNow` must be usable in **conditions and mutation values** (create/update).

2. **Teach SQL compilers to serialize `DbNow`.**
   - File: `packages/fragno-db/src/adapters/generic-sql/query/where-builder.ts`
   - When a condition value is `DbNow`, emit SQL `CURRENT_TIMESTAMP`.
   - Extend the **value serialization path** used for create/update to emit `CURRENT_TIMESTAMP` when
     a column value is `DbNow` (same SQL across Postgres/SQLite/MySQL).
   - In-memory adapter should resolve `DbNow` to `new Date()` for deterministic tests.

3. **Use `dbNow()` in hook queries and updates.**
   - File: `packages/fragno-db/src/fragments/internal-fragment.ts`
   - Replace `new Date()` comparisons in `getPendingHookEvents`, `claimPendingHookEvents`,
     `getNextHookWakeAt` with `dbNow()`.
   - Use `dbNow()` for `lastAttemptAt` updates (processing/completed/failed).

4. **Use DB time as the base for offsets.**
   - Where offsets are required (e.g., `nextRetryAt`, `wakeAt`, `lockedUntil`), compute them from
     **database time**. This can be done by:
     - Fetching a single DB time value per tick/processing cycle and adding offsets in JS, or
     - Introducing a later `DbNow + interval` expression (not required in this spec).

5. **Scope note:** `DbNow` is intentionally the only expression added here. If future requirements
   need more complex DB-side expressions, introduce new value types at that time.

### 4.6 History pagination must support composite cursors

**Problem:** `buildCursorCondition` throws for multi-column indexes. History indexes are composite
(`workflowName`, `instanceId`, `runNumber`, `createdAt`), causing 500s on page 2.

**Fix:** Implement lexicographic comparisons for multi-column cursors.

**Code changes:**

1. **Implement multi-column cursor conditions.**
   - File: `packages/fragno-db/src/adapters/generic-sql/query/cursor-utils.ts`
   - Replace the `throw` for `indexColumns.length > 1` with a lexicographic OR condition.

   For ascending + `after`:

   ```ts
   (col1 > v1)
   OR (col1 = v1 AND col2 > v2)
   OR (col1 = v1 AND col2 = v2 AND col3 > v3)
   ...
   ```

   For descending + `after`, invert the comparison operator (`<`).

2. **Add cursor-pagination tests for composite indexes.**
   - File: `packages/fragno-db/src/adapters/generic-sql/query/cursor-utils.test.ts`
   - Add at least one test for asc and desc with 3-4 index columns.

### 4.7 Postgres restarts must not crash the API server

**Problem:** `pg` pool errors on restarts are unhandled, terminating the process.

**Fix:** Handle pool errors and recreate the pool on demand.

**Code changes:**

- File: `example-apps/wf-example/app/db/db.server.ts`
- When creating a new `Pool`, attach `pool.on("error", ...)` to log and reset cached instances:

  ```ts
  poolInstance.on("error", (error) => {
    console.error("Postgres pool error", error);
    poolInstance = undefined;
    dbInstance = undefined;
  });
  ```

### 4.8 SERIALIZABLE isolation should retry

**Problem:** SERIALIZABLE conflicts (`SQLSTATE 40001`) bubble up as 500s.

**Fix:** Treat serialization failures as concurrency conflicts so handlerTx retries.

**Code changes:**

- File: `packages/fragno-db/src/adapters/generic-sql/generic-sql-uow-executor.ts`
- In `executeMutation`, catch database errors where `error.code` is `40001` or `40P01` and return
  `{ success: false }` (same as optimistic conflict) to trigger retry.

## 5. Testing & Validation

Add or update tests to lock behavior:

- **Batch create returns quickly** without awaiting runner tick (route-level test or integration).
- **Lease renewal guard**: simulate pending task with `lockedUntil` set and ensure it is claimable.
- **Attempt ceiling**: ensure attempts do not exceed `maxAttempts` even under forced concurrency.
- **`waitForEvent` hard timeout**: late event does not complete, step errors.
- **`waitForEvent` late processing**: event created **before** `wakeAt` completes even if processed
  after deadline.
- **Clock skew**: hooks use DB time, `nextRetryAt` comparisons are DB-based.
- **Cursor pagination**: history cursor page 2 works without 500s.
- **SERIALIZABLE retries**: inject a fake `40001` error and ensure retry occurs.

## 6. Compatibility Notes

- Detaching `runner.tick` from hooks means hook success no longer implies tick success. This is
  acceptable because durable hooks are a **wake signal**, not the execution itself.
- Multi-column cursor support is additive and should not change existing single-column behavior.

## Appendix: `DbNow` usage

`DbNow` is a **value** type that represents database time (`CURRENT_TIMESTAMP`). It can be used in:

- **Conditions** (e.g., `nextRetryAt <= dbNow()`).
- **Mutation values** (e.g., `lastAttemptAt = dbNow()`, `updatedAt = dbNow()`).

### Type & factory

```ts
// @fragno-dev/db
export type DbNow = { tag: "db-now" };
export const dbNow = (): DbNow => ({ tag: "db-now" });
```

### Condition example

```ts
uow.find("fragno_hooks", (b) =>
  b.whereIndex("idx_namespace_status_retry", (eb) =>
    eb.and(
      eb("namespace", "=", namespace),
      eb("status", "=", "pending"),
      eb.or(eb.isNull("nextRetryAt"), eb("nextRetryAt", "<=", dbNow())),
    ),
  ),
);
```

### Mutation example

```ts
uow.update("fragno_hooks", event.id, (b) =>
  b.set({
    status: "processing",
    lastAttemptAt: dbNow(),
  }),
);
```

### Serialization rules

- **SQL**: `DbNow` serializes to `CURRENT_TIMESTAMP` for Postgres/SQLite/MySQL.
- **In-memory adapter**: `DbNow` resolves to `new Date()` for test determinism.

### Offset scheduling

When an offset is needed (e.g., `dbNow + delay`), use **DB time** as the base:

1. Fetch a single `dbNow` value at the start of the tick/processing cycle, then
2. Add offsets in JS to derive `nextRetryAt`, `wakeAt`, `runAt`, or `lockedUntil`.

This avoids clock‑skew drift while keeping interval arithmetic out of SQL.
