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
4. [x] Implement the workflow registry + programmatic bindings API (SPEC §6.5, §6.6):
   - fragment exposes `fragment.workflows.<bindingKey>`
   - workflows have access to `this.workflows` for child workflow creation
   - align `createBatch` typing with Cloudflare (`WorkflowInstanceCreateOptionsWithId`; SPEC §6.3)
5. [x] Add minimal docs/examples mirroring `example-fragments/example-fragment/src/index.ts`.

## Phase 2 — Database schema (Fragno DB)

1. [x] Define `workflowsSchema` tables per SPEC §8:
   - `workflow_instance`
   - `workflow_step`
   - `workflow_event`
   - `workflow_task` (required; distributed runners)
2. [x] Provide `withDatabase(workflowsSchema)` integration:
   - follow patterns in `packages/fragment-mailing-list/src/definition.ts`
3. [x] Add indexes needed for runner queries (SPEC §8).
4. [x] Add index to support sendEvent waiting-step lookup without runNumber (issue #4).
5. [x] Add/validate the lease/lock columns needed for distributed runners (task lease only):
   - task lease (`workflow_task.lockOwner/lockedUntil`)
   - unique active task: (`workflowName`, `instanceId`, `runNumber`) (SPEC §8.4)
6. [x] Set retention defaults per SPEC §14.1:
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
3. [x] Implement the Node dispatcher package:
   - in-process `wake()` + optional polling loop (SPEC §5.2)
4. [x] Implement the Cloudflare DO dispatcher package:
   - Durable Object entrypoint + alarm-driven scheduling (SPEC §5.3)
   - v1 shape: one dispatcher DO per DB namespace; keep option open for per-workflow scaling
5. [x] Document the HTTP tick integration path:
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
   - [x] Clear timeout timers on success in `#runWithTimeout` (issue #5)
3. [x] Implement pause/terminate/restart semantics (SPEC §9.4).
4. [x] Make `POST /_runner/tick` safe under concurrency:
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

1. [x] Ensure migrations generation works (per Fragno DB docs and existing CLI flows).
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
   - [x] paused instances are not claimed / no hot-looping (SPEC §9.1.3, §9.4)
4. [x] Add one end-to-end example workflow (approval + event + sleep), and mount in an example app.
5. [x] Add author-facing test harness (Fragno-test integration):
   - deterministic runner ticking + `runUntilIdle`
   - controllable clock for `sleep` + timeouts
   - event injection + status/history helpers
   - documentation/example for user workflows (e.g.
     `example-apps/fragno-db-usage-drizzle/src/fragno/workflows-fragment.ts`)
6. Review remaining issues from `specs/workflows-fragment-implementation-plan-issues.md` and fix
   them.
   - [x] Preserve wakeAt on sleep/wait replay; keep pauseRequested on suspend; normalize
         waitForEvent replay timestamps.
   - [x] Guard background runner ticks against unhandled rejections in example app.
7. [x] Add JSDoc coverage for public workflows APIs to meet docstring requirements.

## Phase 8 — Verification

1. [x] Tests:
       `pnpm turbo run test --filter=@fragno-dev/fragment-workflows --filter=@fragno-dev/db --filter=@fragno-dev/workflows-dispatcher-node --filter=@fragno-dev/workflows-dispatcher-cloudflare-do --filter=@fragno-dev/test`
2. [x] Lint: `pnpm lint`
3. [x] Types: `pnpm types:check`
4. Last verified: 2026-01-18 (tests, lint, types; rerun)

## Phase 9 — Management surface completeness (CLI-ready)

1. [x] Extend instance read APIs to return operator-friendly metadata (SPEC §11.5):
   - `runNumber`, `params`, timestamps, `pauseRequested`
   - `currentStep` summary (last step + wait/retry fields)
2. [x] Add service methods for “current step” summary and instance metadata retrieval.
3. [x] Add tests covering:
   - metadata fields are correct
   - `currentStep` matches the latest step state for `running|waiting|paused`

## Phase 10 — Durable workflow log lines (workflow-authored + optional system logs)

1. [x] Add `workflow_log` table + indexes to `workflowsSchema` (SPEC §8.5).
2. [x] Extend the runner step API to expose a structured logger (SPEC §6.2.1):
   - add `step.log.<level>(message, data?, { category? })`
   - persist log lines with `workflowName/instanceId/runNumber/stepKey?/attempt?`
   - store `isReplay` so replay-emitted logs are obvious/filterable
   - reserve `category="system"` for engine/system logs (optional but recommended)
3. [x] Add services + routes:
   - [x] extend `GET /workflows/:workflowName/instances/:instanceId/history` to optionally include
         logs behind `includeLogs=true`, with independent cursor pagination + filters
4. [x] Add tests:
   - [x] logs are persisted on successful steps
   - [x] logs are persisted on failed attempts + retries
   - [x] replay-emitted logs are marked with `isReplay=true`
   - [x] history only returns logs when `includeLogs=true`
   - [x] log pagination and filtering are stable

## Phase 11 — Workflow management CLI (app)

1. [x] Create new app for the workflow CLI at `apps/fragno-wf` (SPEC §5.4, §17):
   - `fragno-wf` binary
   - reuse the existing CLI style/tooling (`gunshi`) for consistent help output
2. [x] Implement HTTP client layer:
   - base URL is the full fragment base URL (e.g. `https://host/api/workflows`)
   - arbitrary repeatable headers support (user-defined auth)
   - timeouts/retries; human-friendly text output only
3. [x] Implement commands (SPEC §17):
   - list workflows
   - list/get instances (+ `--status`)
   - `instances get --full` for params/output/extra metadata
   - history view (steps/events, optionally logs via `--include-logs`)
   - logs view + `--follow` tailing (polling) via history `includeLogs=true`
   - create, pause/resume/restart/terminate, send-event
   - exclude `createBatch` and runner tick commands
4. [x] Add CLI tests (HTTP client integration against a test server).

## Phase 12 — Workflows docs (separate section + landing page)

1. [x] Create `/docs/workflows` section (like `forms`/`stripe`) with a landing/quickstart page (SPEC
       §18).
2. [x] Move/duplicate the existing workflows doc from `/docs/fragno/for-users/workflows` into the
       new section and leave a pointer page behind to avoid breaking links.
3. [x] Add docs pages:
   - API routes reference (status/history/logs)
   - CLI reference (`fragno-wf`, base URL, headers, examples)
   - Runner/dispatcher integration guide
   - Debugging & troubleshooting (common failure modes)

## Phase 13 — Verification (new additions)

1. [x] Tests: targeted packages + docs build if available
2. [x] Lint + types
