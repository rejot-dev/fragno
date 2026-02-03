# Correctness Test TODO (Expanded)

This checklist captures **additional correctness scenarios** beyond the current smoke tests. Each
item includes what to test, how to provoke the situation, and what invariants must hold.

## [x] 1) Clock Skew / Time Drift Between Dispatchers

**Goal:** Ensure leases, retries, and timeouts are robust when runner clocks disagree.

**How to test**

- Run 2+ dispatchers with different time offsets (e.g., `date` manipulation with `libfaketime` or
  containerized clocks).
- Use workflows with: retry/backoff (`parallel-steps-workflow`) and timeouts
  (`wait-timeout-workflow`).
- Force one dispatcher to be +60s ahead and another -60s behind.

**Expected invariants**

- No tasks are permanently stalled due to clock skew.
- Retry/backoff remains bounded (no immediate rapid retries or excessive delays).
- `waitForEvent` timeouts are respected relative to the **workflow’s own schedule**, not dependent
  on which dispatcher happens to run the timeout tick.

## [x] 2) Event Duplication / Idempotency

**Goal:** Ensure duplicate events do not cause duplicate step executions or multiple completions.

**How to test**

- Send identical events (same `type` + same payload) multiple times to the same instance, including
  while it is paused and immediately after resume.
- Mix duplicates around restart boundaries (send duplicate approval for run 0, then restart, then
  duplicates for run 1).

**Expected invariants**

- At most one event is consumed per `waitForEvent` step.
- Step history should show a single wait step completion.
- No duplicate outputs or double-complete states.

## [x] 3) History Pagination / Cursor Correctness

**Goal:** Ensure `/history` pagination does not drop or duplicate steps/events/logs.

**How to test**

- Create workflows with many steps and events (scripted).
- Fetch history with small `pageSize` and walk cursors forward and backward.
- Compare the full aggregated list to a direct DB query.

**Expected invariants**

- Full history reconstructed from cursors matches DB source (no gaps, no duplicates).
- Ordering remains consistent with `order=asc|desc`.

## [x] 4) Retention / GC Correctness

**Goal:** Ensure completed instances are retained/removed according to retention policy without
orphan rows.

**How to test**

- Configure a short retention window (if supported).
- Complete instances, wait beyond retention, run GC (if manual).
- Inspect DB tables for orphaned steps/events/tasks/logs.

**Expected invariants**

- After GC, no `workflow_step`, `workflow_event`, or `workflow_task` rows remain without a matching
  instance.
- Instances within retention are preserved.

## [x] 5) Large Payload Handling

**Goal:** Verify large params/event/output payloads are stored and retrieved correctly.

**How to test**

- Create instances with large params (hundreds of KB).
- Send events with large payloads.
- Return large outputs from `step.do`.

**Expected invariants**

- No truncation or serialization errors.
- History and instance retrieval returns intact payloads.
- System remains responsive under large payload load.

## [x] 6) Out-of-Order + Interleaved Events Across Restarts

**Goal:** Verify events are bound to the correct runNumber.

**How to test**

- Send `fulfillment` first, then `restart`, then send `approval` for run 1.
- Send additional events late for run 0 after restart.

**Expected invariants**

- Events for run 0 do **not** complete run 1.
- Only run 1 events are consumed after restart.

## [x] 7) Concurrency + Authorization Hooks

**Goal:** Ensure failed auth does not partially mutate workflow state.

**How to test**

- Add an authorize hook that rejects randomly (e.g., 30% failure).
- Fire concurrent create/send-event/pause/resume calls.

**Expected invariants**

- Rejected requests leave no DB mutations.
- Accepted requests behave normally under load.

## [x] 8) Migration Edge Cases

**Goal:** Confirm migrations are safe and idempotent under concurrency.

**How to test**

- Start multiple app servers concurrently with migrate enabled.
- Run migrations while background dispatchers are active.

**Expected invariants**

- Schema ends in a consistent state.
- No partial migrations, no deadlocks, no duplicate indexes.

## [x] 9) Runner Tick Storms

**Goal:** Ensure concurrent `_runner/tick` calls do not cause duplication or corruption.

**How to test**

- Spawn 10–20 concurrent requests to `_runner/tick`.
- Combine with multiple dispatchers.

**Expected invariants**

- Each task/step is claimed once (no duplicate execution).
- Attempts never exceed `maxAttempts`.

## [x] 10) Database Restart Mid-Transaction

**Goal:** Ensure tasks recover from DB restart without stalling or partial commits.

**How to test**

- Restart Postgres while workflows are actively running steps.
- Bring Postgres back and continue dispatchers.

**Expected invariants**

- No tasks stuck in `processing` without recovery.
- Steps eventually complete or retry according to policy.

## [x] 11) Isolation Level Anomalies

**Goal:** Test for correctness regressions under stricter/looser transaction isolation.

**How to test**

- Configure Postgres session isolation to `SERIALIZABLE` and `READ COMMITTED`.
- Run concurrency tests and compare behavior.

**Expected invariants**

- No duplication, no deadlocks, no stalls beyond retry schedule.

## [x] 12) API Cancellation Semantics (Pause/Resume/Terminate)

**Goal:** Ensure cancellation requests are respected even mid‑step.

**How to test**

- Pause/resume rapidly while steps are running.
- Terminate while a long-running step is mid-flight.

**Expected invariants**

- Pause prevents further progress until resume.
- Terminate prevents later commits from overwriting terminal state.

---

If you want, I can convert each section into runnable scripts and add them into
`packages/fragment-workflows/workflows-smoke-artifacts/`.
