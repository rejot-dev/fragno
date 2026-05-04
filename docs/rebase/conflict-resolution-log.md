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
