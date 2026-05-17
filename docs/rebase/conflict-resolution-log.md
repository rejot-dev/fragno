# Rebase conflict resolution log

## `feat(pi-fragment): add command-based sessions`

- `packages/pi-fragment/src/pi/workflow/agent-runner.ts`
  - Conflict: the current branch had the older user-message based runner while the rebased commit introduced command-based prompt/continue execution, tool replay journals, live controllers, and structured run outcomes.
  - Resolution: kept the command-based runner from the rebased commit so the new session command API remains intact.

- `packages/pi-fragment/src/pi/workflow/workflow.ts`
  - Conflict: the current branch used `wait-user-*` workflow events and assistant-only steps while the rebased commit moved to durable `command` events with prompt, continue, abort, steer, follow-up, and complete commands.
  - Resolution: kept the command-based workflow implementation and its operation/turn bookkeeping.

- `packages/pi-fragment/src/pi/workflow-scenarios.test.ts`
  - Conflict: deleted on the rebased side after scenario coverage moved into the newer Pi workflow scenario tests.
  - Resolution: accepted the deletion.

- `packages/pi-fragment/src/pi/workflow/tool-journal.ts` and `.test.ts`
  - Conflict side effect: the chosen command-based runner/workflow depends on the tool journal helpers, but they were not present in the worktree after conflict checkout.
  - Resolution: restored the tool journal implementation and tests from the rebased command-based sessions commit.

## `feat(backoffice): support pi session commands`

- `apps/backoffice/app/fragno/bash-runtime/pi-bash-runtime.ts`
  - Conflict: one side renamed turn submission from the old `/messages` route to the new `/command` route while the current branch had already switched route errors to the richer `throwOnRouteRuntimeError` helper.
  - Resolution: kept the new command route and `promptResponse` handling, but preserved the richer runtime error wrapper for failed prompt submissions.

## `feat(workflows): add step live state`

- `packages/fragment-workflows/src/runner/step.ts`
  - Conflict: the rebased commit introduced workflow step live-state leases and scoped step occurrence tracking in the same runner areas that the current branch had changed.
  - Resolution: accepted the live-state runner implementation from the rebased commit for this intermediate commit; later workflow step-emission commits in the rebase are expected to replace this live-state mechanism.

- `packages/fragment-workflows/src/scenario-runner.test.ts`
  - Conflict: scenario assertions changed around the live-state capable runner.
  - Resolution: accepted the rebased commit's scenario coverage so the intermediate live-state commit remains self-consistent.

## `fix(deps): catalog react dependency versions`

- `pnpm-lock.yaml`
  - Conflict: dependency catalog edits touched the same importer and package resolution sections as the current branch lockfile.
  - Resolution: regenerated the lockfile with `pnpm install --lockfile-only`, which let pnpm merge the lockfile against the updated workspace manifests.

## `feat(workflows): persist and stream step emissions`

- `packages/fragment-workflows/src/schema.ts`
  - Conflict: persisted step emissions were added where the current schema had already removed obsolete explicit workflow instance references and retained table-scoped reference columns.
  - Resolution: kept the current table-scoped `referenceColumn({ table: "workflow_instance" })` approach and obsolete-reference no-op migrations, removed run-number fields, and added the new `workflow_step_emission` table and indexes.

- `example-apps/fragno-db-usage-drizzle/src/schema/fragno-schema.ts`
- `example-apps/fragno-db-usage-drizzle/src/schema/fragno-schema.mysql.ts`
- `example-apps/fragno-db-usage-drizzle/src/schema/fragno-schema.sqlite.ts`
  - Conflict: generated Drizzle relation names differed for existing workflow events while the rebased commit added workflow step emission relations.
  - Resolution: preserved the existing `workflow_event_instanceRef` relation name and added the new workflow step emission relation/list entries.

## `feat(pi-fragment): add lifecycle event routes`

- `packages/pi-fragment/src/pi/types.ts`
  - Conflict: the command-based sessions commit still defined the older layered active-session protocol messages, while the lifecycle event route commit replaces them with flat session event stream frames (`snapshot`, agent events, abort, steer).
  - Resolution: kept the new `PiSessionEventStreamItem` union and aliased `PiActiveSessionProtocolMessage` to it for compatibility.
