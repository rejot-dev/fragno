# Fragno Workflows Fragment — Implementation Plan (Draft)

This plan assumes the design in `specs/workflows-fragment-spec.md`.

## Phase 0 — Grounding + references

1. Pull Cloudflare API surface from `https://developers.cloudflare.com/workflows/llms-full.txt`:
   - `WorkflowEntrypoint`, `WorkflowStep`, `WorkflowEvent`, `WorkflowStepConfig`, `Workflow`
   - Instance management methods (`create/get/createBatch`,
     `pause/resume/restart/terminate/sendEvent`)
2. Reconfirm Fragno DB primitives and durable hooks patterns:
   - `apps/docs/content/docs/fragno/for-library-authors/database-integration/overview.mdx`
   - `apps/docs/content/docs/fragno/for-library-authors/database-integration/durable-hooks.mdx`
   - `packages/fragno-db/src/db-fragment-definition-builder.ts` (hook wiring)

## Phase 1 — New package(s) + public API scaffolding

1. Create the packages per SPEC §5:
   - [x] `packages/fragment-workflows` (`@fragno-dev/fragment-workflows`)
   - [x] `packages/workflows-dispatcher-node` (`@fragno-dev/workflows-dispatcher-node`)
   - [x] `packages/workflows-dispatcher-cloudflare-do`
         (`@fragno-dev/workflows-dispatcher-cloudflare-do`)
2. Ensure the main package is runtime-agnostic (SPEC §5.3 note); keep Cloudflare/Node APIs in the
   dispatcher packages.
3. [x] Implement public types/classes per SPEC §6:
   - `WorkflowEntrypoint`, `WorkflowStep`, `WorkflowEvent`, `WorkflowStepConfig`, `InstanceStatus`
   - `NonRetryableError`
4. Implement the workflow registry + programmatic bindings API (SPEC §6.5, §6.6):
   - fragment exposes `fragment.workflows.<bindingKey>`
   - workflows have access to `this.workflows` for child workflow creation
   - align `createBatch` typing with Cloudflare (`WorkflowInstanceCreateOptionsWithId`; SPEC §6.3)
5. Add minimal docs/examples mirroring `example-fragments/example-fragment/src/index.ts`.

## Phase 2 — Database schema (Fragno DB)

1. [x] Define `workflowsSchema` tables per SPEC §8:
   - `workflow_instance`
   - `workflow_step`
   - `workflow_event`
   - `workflow_task` (required; distributed runners)
2. [x] Provide `withDatabase(workflowsSchema)` integration:
   - follow patterns in `packages/fragment-mailing-list/src/definition.ts`
3. Add indexes needed for runner queries (SPEC §8).
4. Add/validate the lease/lock columns needed for distributed runners (task lease only):
   - task lease (`workflow_task.lockOwner/lockedUntil`)
   - unique active task: (`workflowName`, `instanceId`, `runNumber`) (SPEC §8.4)
5. Set retention defaults per SPEC §14.1:
   - `retentionUntil = null` (infinite retention) for all instances by default

## Phase 3 — Services (instance lifecycle + eventing)

1. [x] Implement core services using `this.serviceTx(schema)` (SPEC §7.1):
   - create instance (+ createBatch)
   - list instances (SPEC §11.2)
   - get status
   - pause/resume/terminate/restart
   - sendEvent (buffering + paused support; reject on terminal; SPEC §9.5, §11.7)
2. Ensure every state-changing operation schedules work and triggers durable hooks:
   - `uow.triggerHook("onWorkflowEnqueued", ...)` (SPEC §10)

## Phase 4 — Durable hooks dispatcher wiring

1. [x] Add `provideHooks` to the fragment definition (SPEC §10.1).
2. [x] Define a dispatcher interface in the main package used by `onWorkflowEnqueued` (SPEC §5.1,
       §10.3).
3. Implement the Node dispatcher package:
   - in-process `wake()` + optional polling loop (SPEC §5.2)
4. Implement the Cloudflare DO dispatcher package:
   - Durable Object entrypoint + alarm-driven scheduling (SPEC §5.3)
   - v1 shape: one dispatcher DO per DB namespace; keep option open for per-workflow scaling
5. Document the HTTP tick integration path:
   - configure durable hook handler to `fetch("/_runner/tick")` (SPEC §11.9)

## Phase 5 — Runner (execution engine)

1. Implement the “runner core” that can:
   - [x] claim runnable tasks with OCC + leases (SPEC §9.1.1)
   - [x] renew task leases while executing (heartbeat) (SPEC §9.1.1)
   - [x] run the workflow with replay semantics (SPEC §9.2)
   - [x] persist step states/results, waits, retries, outputs/errors (SPEC §9.3)
   - [x] schedule/update the single per-run task row (SPEC §9.1.3)
   - [x] process tasks in Cloudflare-like priority order (SPEC §9.1.2)
2. Implement step methods:
   - [x] `do` (cached results + retries + timeouts)
   - [x] `sleep` / `sleepUntil` (schedule wake)
   - [x] `waitForEvent` (buffered event matching + timeout)
3. Implement pause/terminate/restart semantics (SPEC §9.4).
4. Make `POST /_runner/tick` safe under concurrency:
   - multiple callers == distributed runners (SPEC §9.1.1)
5. Implement task compaction:
   - [x] delete/prune `workflow_task` rows once `completed` (SPEC §8.4, §14.1)

## Phase 6 — HTTP API routes

1. [x] Define routes with `defineRoutes(fragmentDef).create(...)` like:
   - `example-fragments/example-fragment/src/index.ts`
2. Implement endpoints per SPEC §11:
   - [x] list workflows
   - [x] list instances
   - [x] create/createBatch
   - [x] status
   - [x] pause/resume/terminate/restart
   - [x] send event
   - [x] history
   - [x] `/_runner/tick`
3. [x] Add auth hooks per SPEC §12.

## Phase 7 — Migrations, tests, and examples

1. Ensure migrations generation works (per Fragno DB docs and existing CLI flows).
2. Add unit tests for:
   - [x] step caching + replay
   - [x] step caching is keyed by name (SPEC §9.2)
   - [x] waitForEvent buffering and timeout
   - [x] retry scheduling semantics
   - [x] pause/resume/terminate/restart

- [x] pause does not freeze timers (SPEC §9.4)

3. Add distributed runner tests (must be robust):
   - [x] N parallel runners contending for the same tasks/instances (SPEC §9.1.1)
   - [x] concurrent `POST /_runner/tick` calls against the same DB state
   - [x] lease expiry + takeover correctness
   - [x] task ordering: `wake|retry|resume` runs before `run` (SPEC §9.1.2)
   - paused instances are not claimed / no hot-looping (SPEC §9.1.3, §9.4)
4. [x] Add one end-to-end example workflow (approval + event + sleep), and mount in an example app.
