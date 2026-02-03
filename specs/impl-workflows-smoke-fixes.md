# Workflows Reliability Fixes - Implementation Plan

- [ ] Update `packages/fragno-db/src/db-fragment-definition-builder.ts` to schedule
      `processHooks(...)` asynchronously in `onAfterMutate` (do not await) and log failures per Spec
      4.1.
- [ ] Wrap batch create handler in `packages/fragment-workflows/src/routes.ts` with `try/catch` +
      `handleServiceError` per Spec 4.1.
- [ ] Guard lease renewal in `packages/fragment-workflows/src/runner/task.ts` by requiring
      `status === "processing"` and `lockOwner === runnerId`, and ignore leases on pending tasks
      when claiming (Spec 4.2).
- [ ] Add the `maxAttempts` pre-run guard in `packages/fragment-workflows/src/runner/step.ts` and
      ensure attempts never exceed the configured maximum (Spec 4.3).
- [ ] Enforce hard `waitForEvent` deadlines in `packages/fragment-workflows/src/runner/step.ts`
      using **event.createdAt <= wakeAt**; allow late processing when created before deadline.
      Update `sendEvent` wake logic in `packages/fragment-workflows/src/definition.ts` to gate on
      `wakeAt > dbNow()` (Spec 4.4).
- [ ] Introduce `DbNow`/`dbNow()` as a **value** type and update serialization: - conditions in
      `packages/fragno-db/src/adapters/generic-sql/query/where-builder.ts` - create/update value
      serialization path - in-memory evaluator to resolve `DbNow` to `new Date()` (Spec 4.5).
- [ ] Replace local `new Date()` comparisons and updates with `dbNow()` in
      `packages/fragno-db/src/fragments/internal-fragment.ts` hook queries and `lastAttemptAt`
      updates (Spec 4.5).
- [ ] Base scheduling offsets on **DB time** (fetch dbNow once per cycle and add offsets) for
      `nextRetryAt`, `wakeAt`, `lockedUntil`, and `runAt` in workflow runner + hooks (Spec 4.5).
- [ ] Implement composite cursor conditions in
      `packages/fragno-db/src/adapters/generic-sql/query/cursor-utils.ts` and add tests covering
      asc/desc pagination (Spec 4.6).
- [ ] Map SQLSTATE `40001`/`40P01` to concurrency conflicts in
      `packages/fragno-db/src/adapters/generic-sql/generic-sql-uow-executor.ts` (Spec 4.8).
- [ ] Add `pg` pool error handling in `example-apps/wf-example/app/db/db.server.ts` to reset cached
      pool/db instances (Spec 4.7).
- [ ] Add/adjust tests in `packages/fragment-workflows/src/runner.test.ts`,
      `packages/fragment-workflows/src/services.test.ts`, and
      `packages/fragno-db/src/adapters/generic-sql/query/cursor-utils.test.ts` to cover the new
      behaviors (Spec 5).
