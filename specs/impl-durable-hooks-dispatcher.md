# Durable Hooks Dispatchers — Implementation Plan

Spec: `./spec-durable-hooks-dispatcher.md`

This work **replaces** `@fragno-dev/workflows-dispatcher-node` and
`@fragno-dev/workflows-dispatcher-cloudflare-do` with durable hooks dispatchers in `@fragno-dev/db`.

- [ ] Add `processAt` (Date only) to `TriggerHookOptions`, clamp to `Date`, and set `nextRetryAt` on
      hook creation in `prepareHookMutations` (Spec 4.1-4.2).
- [ ] Add an internal hook service query for the earliest pending hook wake time and return `now`
      when any pending hook has `nextRetryAt = null` (Spec 5).
- [ ] Persist durable hook config on fragment instances and implement `createDurableHooksProcessor`
      (Spec 5).
- [ ] Ensure all dispatcher/processor DB access uses `fragment.inContext()` + `handlerTx()` and does
      not use `deps.db` (Spec 5.1).
- [ ] Add Node dispatcher module under `@fragno-dev/db/dispatchers/node` with polling, wake, and
      in-flight coalescing (Spec 6.1).
- [ ] Add Cloudflare DO dispatcher module under `@fragno-dev/db/dispatchers/cloudflare-do` with
      alarm scheduling and coalescing (Spec 6.2).
- [ ] Add tests for `processAt`, `getNextWakeAt`, and dispatcher behavior (Spec 10).
- [ ] Update workflows runner scheduling to trigger `onWorkflowEnqueued` with `processAt` for future
      tasks and call `runner.tick` inside the hook (Spec 7.1).
- [ ] Replace `@fragno-dev/workflows-dispatcher-node` and
      `@fragno-dev/workflows-dispatcher-cloudflare-do` with shims that re-export the new db
      dispatchers, and remove their usage from docs/examples (Spec 8.2).
- [ ] Update package exports and tsdown entries for new db dispatcher modules (Spec 8.1).
- [ ] Update docs: durable hooks, workflows quickstart/fragment/runner-dispatcher pages (Spec 9).
