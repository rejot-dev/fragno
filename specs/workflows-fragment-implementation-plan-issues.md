# PR 204 Comment-Derived Issues

Source: [PR #204](https://github.com/rejot-dev/fragno/pull/204)

## Issues

1. Update PR title to be specific to workflows fragment changes.
   - Source: CodeRabbit pre-merge checks (issue comment).

2. Raise docstring coverage to the required threshold (80%).
   - Source: CodeRabbit pre-merge checks (issue comment).
   - Note: The comment also flags a finishing-touch task to generate docstrings.

3. Guard against unhandled rejections from background runner ticks.
   - Source: CodeRabbit review comment.
   - Files: `example-apps/fragno-db-usage-drizzle/src/fragno/workflows-fragment.ts`.
   - Action: Add `.catch(...)` logging on `runner.tick(...)` in the dispatcher wake handler.

4. Use `runNumber` in `sendEvent` step lookup (or add a matching index).
   - Source: CodeRabbit review comment.
   - Files: `packages/fragment-workflows/src/definition.ts`.
   - Action: Include `runNumber` in the `idx_workflow_step_status_wakeAt` filter or add a new index
     keyed for this query.

5. Clear timeout timers on success in `#runWithTimeout`.
   - Source: CodeRabbit review comment.
   - Files: `packages/fragment-workflows/src/runner.ts`.

6. Reword duplicate “Events are scoped to an instance run” bullet and add “etc.” period.
   - Source: CodeRabbit review comment.
   - Files: `specs/workflows-fragment-spec.md`.

7. Preserve original `wakeAt` when resuming paused sleeps or waits.
   - Source: Cursor review comment.
   - Files: `packages/fragment-workflows/src/runner.ts`.
   - Notes: Affects `sleep`/`waitForEvent` replay paths where existing step rows are reused.

8. Keep `pauseRequested` state when a workflow suspends.
   - Source: Cursor review comment.
   - Files: `packages/fragment-workflows/src/runner.ts`.

9. Ensure `waitForEvent` returns a `Date` on replay (deserialize stored timestamp or adjust type).
   - Source: Cursor review comment.
   - Files: `packages/fragment-workflows/src/runner.ts`,
     `packages/fragment-workflows/src/workflow.ts`.
