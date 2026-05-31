# Workflows Smoke Test Report

This directory has been refreshed for the current workflow fragment API.

## Current API assumptions

- Workflow execution is driven by durable hooks (`onWorkflowEnqueued`) and durable hook processors.
- Public routes are the routes in `src/routes.ts`: workflow list, instance list/create/batch,
  instance detail, full history, current-step emissions, pause/resume/terminate, and send-event.
- There is no public restart route, no public `_runner/tick` route, and no public history pagination
  route in the current source.
- Instance list pagination remains public through `GET /:workflowName/instances?pageSize&cursor`.
- Current-step emissions are available through
  `GET /:workflowName/instances/:instanceId/current-step/emissions?once=true` or a live stream.

## Updated artifacts

- Added shared helper: `smoke-support.js`.
- Updated stale absolute imports in `dispatcher.ts`, `dispatcher-skew.ts`, and `migration-edge.ts`.
- Updated public-route scripts to use current history/status shapes and current step keys.
- Replaced obsolete `_runner/tick` storming with durable-hook/event storming.
- Replaced history cursor checks with instance-list cursor checks plus full-history validation.
- Marked restart/runNumber scripts as compatibility guards because restart is not part of the
  current API.
- Replaced retention/GC checks with public integrity checks because no retention/GC policy is
  exposed.

## Recommended evidence to capture when running

For each run, record:

- command and env (`BASE_URL`, database URL, dispatcher count, payload sizes);
- generated instance IDs;
- terminal status counts;
- history invariants (consumed events, step attempt bounds, emission cleanup);
- process/fault timeline for crash, dispatcher, and DB restart scripts.

See `../TESTING_PLAN.md` and `correctness-todo.md` for the full plan and checklist.

## 2026-05-31 local testing start

### Fast in-repo layer

- `pnpm exec turbo types:check --filter=@fragno-dev/workflows --output-logs=errors-only` — passed
  from cache (`5 successful`).
- `pnpm exec turbo test --filter=@fragno-dev/workflows --output-logs=errors-only` — passed from
  cache (`6 successful`).
- `node --check packages/fragment-workflows/workflows-smoke-artifacts/*.js` — passed for 25
  JavaScript smoke scripts.

### Example-app smoke attempt: Postgres.app 18

Environment and setup:

- Initial documented URL `postgres://postgres:postgres@localhost:5436/wilco` failed during app
  startup with `relation "fragno_db_settings" already exists`, indicating the shared `wilco`
  database was not a clean smoke target.
- Created fresh Postgres databases for subsequent attempts, including:
  - `fragno_wf_example_20260531_121030_26123`
  - `fragno_wf_example_20260531_121532_15289`
  - `fragno_wf_example_20260531_122604_29809`
  - `fragno_wf_example_20260531_122847_220`
- Started `pnpm --filter @fragno-example/wf-example dev` with fresh database URLs and verified
  `GET http://localhost:5173/api/workflows` returned the configured workflows.

Commands attempted:

```bash
BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/create-race.js
BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/load-concurrency.js
COUNT=1 BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/load-concurrency.js
BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/load-parallel.js
BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/duplicate-event-idempotency.js
BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/history-pagination.js
BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/large-payload.js
BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/wait-timeout-edge.js
BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/terminate-race.js
BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/terminate-running-parallel.js
BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/scenario-matrix.js
```

Observed results:

- `create-race.js` reached its current expected outcome: one `200` and four duplicate/concurrent
  `500` responses.
- The baseline smoke suite is blocked locally by Postgres.app authentication failures from the
  app/dispatcher process:
  - `Postgres.app failed to verify "trust" authentication`
  - detail: `You did not confirm the permission dialog.`
  - hint: `Configure app permissions in Postgres.app settings`
- Because of that local DB auth failure, workflow instances stayed `active` and scripts that need
  the durable-hook dispatcher to advance workflows failed or timed out.
- Representative failing outputs:
  - `load-concurrency.js`: create failures with `500 INTERNAL_SERVER_ERROR`; with `COUNT=1`,
    approval event/status calls also returned `500` and the instance timed out.
  - `history-pagination.js`: timed out waiting for approval instances to reach
    `waiting for approval`.
  - `large-payload.js`: timed out waiting for the large approval instance to reach
    `waiting for approval`.
  - `wait-timeout-edge.js`: all 20 instances failed to reach waiting state.
  - `terminate-race.js`, `terminate-running-parallel.js`, `scenario-matrix.js`: failed on
    `500 INTERNAL_SERVER_ERROR` during create/status/event paths.

Evidence logs:

- `/tmp/wf-example-dev-fragno_wf_example_20260531_121532_15289.log`
- `/tmp/wf-smoke-baseline-20260531-121545.log`
- `/tmp/wf-smoke-baseline-continue-20260531-121824.log`
- `/tmp/wf-smoke-probe-20260531-122611.log`
- `/tmp/wf-example-dev-fragno_wf_example_20260531_122847_220.log`

Next action before rerunning smoke: resolve local Postgres.app permissions for the Node/React Router
dev process, or run the smoke target against a non-Postgres.app database endpoint that uses password
authentication without the Postgres.app trust-permission dialog.

### 2026-05-31 Postgres.app confirmation rerun

Added `confirm-postgres-app.sh` to automate the fresh-DB + wf-example + smoke-script confirmation
flow.

Runs after adjusting Postgres.app permissions no longer showed the trust-auth failure, and workflows
advanced far enough to hit smoke/product assertions instead of local DB authentication errors:

- `packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh`
  - database: `fragno_wf_confirm_20260531_140353_45923`
  - `duplicate-event-idempotency.js` failed because the instance became `errored` instead of
    `complete`.
  - DB evidence: `workflows.workflow_instance.errorMessage = BUFFERED_PUMP_SCOPE_ALREADY_OPEN`.
- `packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh history-pagination.js`
  - database: `fragno_wf_confirm_20260531_140427_47546`
  - `history-pagination.js` failed with `completed instance ... missing from paginated list`.

Interpretation: local Postgres.app authentication is now unblocked; remaining failures are
workflow/smoke correctness issues to investigate.

### 2026-05-31 investigation notes (reports only)

No implementation changes are being kept for these findings. Product-code trial edits were reverted;
only smoke artifacts/reporting remain changed.

#### Finding A: duplicate-event/idempotency smoke has unstable outcomes under concurrent event hooks

Reproduction command:

```bash
packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh
```

Observed runs:

- `fragno_wf_confirm_20260531_140353_45923`: `duplicate-event-idempotency.js` failed because
  terminal status was `errored`; DB evidence showed
  `workflow_instance.errorMessage = BUFFERED_PUMP_SCOPE_ALREADY_OPEN`.
- `fragno_wf_confirm_20260531_141852_91423`: same script reached `complete`, but failed
  `fulfillment duplicates were not persisted for idempotency inspection`.
  - DB evidence: 10 approval events persisted, but only 4 fulfillment events persisted; 1
    fulfillment was consumed and 3 remained unconsumed.

Interpretation/report:

- There appears to be a race around duplicate event delivery while the workflow is waiting/advancing
  through `waitForEvent` and step-emission pump scope handling.
- A separate smoke-script expectation may also be too strict for events sent after the instance has
  already reached terminal state: terminal event submissions can return `409 INSTANCE_TERMINAL`, so
  `DUPLICATE_COUNT` events are not guaranteed to be persisted after completion races.

#### Finding B: status-filtered pagination can skip completed instances when cursor timestamps collide/truncate

Reproduction observed earlier:

```bash
packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh history-pagination.js
```

Observed run:

- `fragno_wf_confirm_20260531_140427_47546`: `history-pagination.js` failed with
  `completed instance ... missing from paginated list`.
- DB evidence for that run showed all 7 instances were `complete`, with `updatedAt` values in the
  same few milliseconds.
- Public pagination over `GET /approval-workflow/instances?status=complete&pageSize=2` returned
  pages:
  - page 1: `_2`, `_1`, cursor timestamp rounded/truncated to `...32.301Z`
  - page 2: `_6`, `_4`, cursor timestamp rounded/truncated to `...32.300Z`
  - page 3: `_5`
  - missing: `_0`, `_3`

Interpretation/report:

- The public status-filtered list uses the `workflowName,status,updatedAt` index for cursor
  pagination.
- Cursor serialization appears to lose timestamp precision relative to Postgres row values
  (microseconds), so rows sharing the same millisecond boundary can be skipped.
- This reproduced once and then passed on a later run, so track as a flake/product issue rather than
  a deterministic local smoke failure.

#### Finding C: wait-timeout edge smoke sends “before timeout” events too close to wake processing and consistently loses to timeout

Reproduction command:

```bash
packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh wait-timeout-edge.js
```

Observed run:

- `fragno_wf_confirm_20260531_141934_94853`: all `edge_before_*` instances errored with
  `WAIT_FOR_EVENT_TIMEOUT`.
- Representative DB timing:
  - wait step created: `2026-05-31 14:19:37.085336`
  - before-event created: `2026-05-31 14:19:39.165834`
  - wait step errored: `2026-05-31 14:19:39.191439`
  - event stayed unconsumed (`deliveredAt` and `consumedByStepKey` null)

Interpretation/report:

- The smoke sends “before” events at `timeoutMs - 150ms` after waiting-state detection, not relative
  to the persisted `wakeAt`/step creation timestamp.
- In practice those requests land only ~25–30ms before the timeout update and lose to the wake hook,
  so this currently reports a boundary race rather than a clearly-before-timeout invariant.
- This may be either expected boundary behavior that should be documented, or the smoke should be
  split into a clearly-before case and a true boundary-race case.

#### Finding D: scenario matrix can flag retry attempt bounds on naturally flaky example workflow

Observed run:

- In `/tmp/wf-smoke-baseline-green-20260531-141523.log`, `scenario-matrix.js` flagged:
  `parallel sm_par_mptqtv8v_3 exceeded attempts on do:fetch-user`.
- DB evidence showed `do:fetch-user attempts = 6`, `maxAttempts = 5`, terminal error
  `FLAKY_USER_FETCH`.

Interpretation/report:

- The example workflow uses random failures and remote fetches, so the smoke can expose retry
  accounting issues but is not fully deterministic.
- For production gating this should move to the dedicated deterministic harness proposed in
  `TESTING_PLAN.md`.

### 2026-05-31 smoke artifact fixes

The following observations were determined to be smoke-artifact issues rather than workflow-product
findings and were fixed in the scripts:

- `duplicate-event-idempotency.js`: count only successfully accepted duplicate event requests when
  asserting history persistence; concurrent duplicates that lose to terminalization may validly
  return `409 INSTANCE_TERMINAL`.
- `wait-timeout-edge.js`: send the “before timeout” event clearly before the timeout window instead
  of ~150ms before the edge, so the script validates normal before/after behavior instead of
  scheduler-boundary timing.
- `clock-skew-timeout.js`: use the current step key shape, `waitForEvent:edge-wait`, when reading
  `wakeAt` from history.
- `pause-resume-race.js`: keep polling/resuming paused instances during the final cleanup sweep so a
  pause event processed after an early no-op resume is not mistaken for a workflow correctness
  failure.
- `crash-recover.js`, `dispatcher-crash-recover.js`, and `stress-fault.js`: spawn dispatchers with
  the current Node process plus `--import tsx` instead of requiring a global `tsx` binary or shell
  shim.
- `dispatcher.ts`: allow smoke scripts to set `WF_STUCK_PROCESSING_TIMEOUT_MINUTES` so
  crash-recovery tests can requeue processing hooks within the test timeout.
- `confirm-postgres-app.sh`: pass `WF_EXAMPLE_DATABASE_URL` through to smoke scripts that launch
  external dispatchers or query the database directly.

### 2026-05-31 continued production-readiness smoke investigation

Scope: report-only. No workflow implementation changes were made. Runs used Postgres.app 18 on
`localhost:5436`, fresh databases per `confirm-postgres-app.sh`, and `PORT=5174` because another
local dev server was already listening on `5173`.

#### Additional passing Postgres smoke coverage

The following example-app smoke scripts passed before later scripts in the same fresh DB run failed:

- `create-race.js`, `load-concurrency.js`, `load-parallel.js` in
  `fragno_wf_confirm_20260531_164918_91951` before `duplicate-event-idempotency.js` failed.
- `history-pagination.js`, `large-payload.js`, `wait-timeout-edge.js`, `terminate-race.js`,
  `terminate-running-parallel.js` in `fragno_wf_confirm_20260531_165222_3444` before
  `scenario-matrix.js` failed.
- `pause-event-race.js`, `pause-resume-race.js`, `clock-skew-retry.js`, `clock-skew-timeout.js` in
  `fragno_wf_confirm_20260531_165324_6885` before `runner-tick-storm.js` failed.
- Restart compatibility guards and `auth-hook-concurrency.js` in
  `fragno_wf_confirm_20260531_165504_11564` before `retention-gc-check.js` failed.
- `crash-recover.js` completed crash recovery in `fragno_wf_confirm_20260531_165540_13275`.
- `dispatcher-crash-recover.js` passed in `fragno_wf_confirm_20260531_165628_15798`.
- `stress-fault.js` passed with the app's internal dispatcher enabled in
  `fragno_wf_confirm_20260531_165655_17105`.
- `stress-fault.js` also passed with `WF_DISABLE_INTERNAL_DISPATCHER=1` and external dispatcher
  counts `2`, `4`, `8`, and `16`:
  - `DISPATCHER_COUNT=2`: `fragno_wf_confirm_20260531_165745_19695`
  - `DISPATCHER_COUNT=4`: `fragno_wf_confirm_20260531_165817_21282`
  - `DISPATCHER_COUNT=8`: `fragno_wf_confirm_20260531_165844_22628`
  - `DISPATCHER_COUNT=16`: `fragno_wf_confirm_20260531_165910_24203`

Interpretation: simple lifecycle/load, timeout, termination, dispatcher restart, and
multi-dispatcher stress paths can pass on Postgres. This is useful evidence, but not sufficient for
production readiness because deterministic custom harnesses, MySQL/SQLite lanes, mock external
services, and several chaos cases are still missing.

#### Finding I: duplicate event storms can deterministically error instances with `BUFFERED_PUMP_SCOPE_ALREADY_OPEN`

Reproduction commands:

```bash
PORT=5174 packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh runner-tick-storm.js
EVENT_STORM_COUNT=2 COUNT=1 PORT=5174 \
  packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh runner-tick-storm.js
```

Observed runs:

- `fragno_wf_confirm_20260531_165324_6885`: default `runner-tick-storm.js` errored all 12
  `hookstorm_*` instances.
- `fragno_wf_confirm_20260531_165426_9843`: default `runner-tick-storm.js` failed again with
  `BUFFERED_PUMP_SCOPE_ALREADY_OPEN`.
- `fragno_wf_confirm_20260531_170034_28658`: `COUNT=1 EVENT_STORM_COUNT=1` passed.
- `fragno_wf_confirm_20260531_170040_29010`: `COUNT=1 EVENT_STORM_COUNT=2` failed with
  `BUFFERED_PUMP_SCOPE_ALREADY_OPEN`.
- `fragno_wf_confirm_20260531_170113_30531` and `fragno_wf_confirm_20260531_170116_30731`:
  `COUNT=1 EVENT_STORM_COUNT=4/8` failed quickly; DB state still showed the instance errored with
  `BUFFERED_PUMP_SCOPE_ALREADY_OPEN` after two persisted approval events.

Representative DB evidence from `fragno_wf_confirm_20260531_165324_6885`:

- all 12 `hookstorm_*` instances had `workflow_instance.status = errored` and
  `errorMessage = BUFFERED_PUMP_SCOPE_ALREADY_OPEN`;
- each instance still had only `waitForEvent:approval` in `workflow_step`, with step status
  `waiting`;
- each instance had 8 persisted approval events and 0 consumed approval events.

Representative single-instance evidence from `fragno_wf_confirm_20260531_170040_29010`:

- instance `hookstorm_mptwpv1c_fj3a5x_0`: `status = errored`,
  `errorMessage = BUFFERED_PUMP_SCOPE_ALREADY_OPEN`;
- approval events: 2 persisted, 0 consumed.

The same error also appears after prior load when running `duplicate-event-idempotency.js` in the
same DB:

- `fragno_wf_confirm_20260531_164918_91951`: duplicate instance errored after load scripts; approval
  events 10 persisted/1 consumed, fulfillment events 5 persisted/0 consumed, final instance error
  `BUFFERED_PUMP_SCOPE_ALREADY_OPEN`.
- `fragno_wf_confirm_20260531_165055_96608`: duplicate instance errored before consuming any
  approval event; approval events 5 persisted/0 consumed.
- `fragno_wf_confirm_20260531_165144_98937`: duplicate instance errored while waiting for
  fulfillment; approval events 10 persisted/1 consumed, fulfillment events 5 persisted/0 consumed.

Control runs: `duplicate-event-idempotency.js` passed three consecutive times when run alone
(`fragno_wf_confirm_20260531_165032_95302`, `_165038_95685`, `_165044_96053`).

Interpretation/report:

- This is a product-readiness blocker. Concurrent user events for a waiting workflow can surface an
  internal buffered-pump scope collision and mark the workflow instance `errored`.
- The error leaves externally confusing state: instance terminal `errored`, but the latest/current
  step can still be a `waiting` step, and user events remain unconsumed.
- A production workflow engine should tolerate duplicate/concurrent event submissions by consuming
  at most one matching event, leaving extras unconsumed or rejecting late terminal submissions; it
  should not terminal-error the instance with an internal pump error.

#### Finding J: retry accounting can exceed `maxAttempts` in the scenario matrix

Reproduction command:

```bash
PORT=5174 packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh \
  history-pagination.js large-payload.js wait-timeout-edge.js terminate-race.js \
  terminate-running-parallel.js scenario-matrix.js
```

Observed run:

- `fragno_wf_confirm_20260531_165222_3444`: `scenario-matrix.js` failed with
  `parallel sm_par_mptwffhr_0 exceeded attempts on do:fetch-user`.

DB evidence:

- instance `sm_par_mptwffhr_0`: `status = errored`, `errorMessage = FLAKY_USER_FETCH`;
- step `do:fetch-user`: `status = errored`, `attempts = 6`, `maxAttempts = 5`;
- global query in that DB showed exactly one step with `attempts > maxAttempts`.

Interpretation/report:

- The scenario uses a naturally flaky example workflow, so the failing instance is not deterministic
  by seed. However, `attempts > maxAttempts` is a core invariant violation independent of the random
  failure source.
- This should be reproduced in the future deterministic retry harness from `TESTING_PLAN.md`, but
  the current evidence is enough to keep retry accounting on the product-risk list.

#### Finding K: `current-step/emissions?once=true` returns `null`/empty body for no emissions despite an array-shaped route contract

Reproduction command:

```bash
PORT=5174 packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh \
  restart-event-race.js restart-fulfillment-leak.js restart-race.js \
  auth-hook-concurrency.js retention-gc-check.js
```

Observed run:

- `fragno_wf_confirm_20260531_165504_11564`: `retention-gc-check.js` failed with
  `TypeError: Cannot read properties of null (reading 'length')` after completing the approval
  workflow and querying current-step emissions for a terminal instance.

Interpretation/report:

- The public route declares an array output for
  `GET /:workflowName/instances/:instanceId/current-step/emissions?once=true`.
- For a terminal/no-emissions case, the smoke helper parsed an empty response body as `null`, so
  callers do not receive `[]` even though the route contract is array-shaped.
- This is either an API response bug (`once=true` should serialize an empty array) or a client/smoke
  helper compatibility gap, but as-is it is not a clean production API contract.

#### Finding L: concurrent migrations on an empty Postgres database are not idempotent/safe

Manual reproduction command:

```bash
# fresh database: fragno_wf_20260531_165952_migration
for i in 1 2 3 4; do
  WF_EXAMPLE_DATABASE_URL=postgres://wilco@localhost:5436/fragno_wf_20260531_165952_migration \
    node --conditions=development --import tsx \
    packages/fragment-workflows/workflows-smoke-artifacts/migration-edge.ts \
    >/tmp/wf-migration-20260531_165952_migration-$i.log 2>&1 &
done
wait
```

Observed result:

- 1 of 4 migration processes completed.
- 3 of 4 failed while concurrently creating base DB metadata tables/sequences.
- Representative errors:
  - `duplicate key value violates unique constraint "pg_class_relname_nsp_index"`, detail
    `fragno_db_settings__internalId_seq already exists`;
  - `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`, detail
    `fragno_db_settings already exists`.
- Afterward, `fragno_db_settings` contained `.schema_version = 7` and
  `workflows.schema_version = 6`, so one process converged the schema but the concurrent callers
  failed rather than all converging cleanly.
- Failed DB retained for inspection: `fragno_wf_20260531_165952_migration`.

Interpretation/report:

- This is a production-readiness blocker for apps that can start multiple API/dispatcher processes
  against a fresh database at the same time.
- The migration path needs either external serialization, DB advisory locking, transactional
  create-if-not-exists behavior, or documented startup requirements that only one migrator runs at a
  time.

#### Finding M: crash-recovery smoke must be isolated because it intentionally kills the API server

Observed command:

```bash
PORT=5174 packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh \
  crash-recover.js dispatcher-crash-recover.js stress-fault.js
```

Observed run:

- `fragno_wf_confirm_20260531_165540_13275`: `crash-recover.js` completed and recovered 5
  `crash-test-workflow` instances to `complete`.
- The next script, `dispatcher-crash-recover.js`, failed with `fetch failed` / `ECONNREFUSED`
  because `crash-recover.js` had intentionally killed the wf-example API process and
  `confirm-postgres-app.sh` did not restart it between scripts.

Interpretation/report:

- This is a smoke-runner/harness limitation, not a workflow-product failure.
- Fault scripts that kill the API process need to run in isolated confirmation invocations, or the
  future suite runner needs lifecycle hooks that can restart the app between destructive tests.

#### Current production-readiness conclusion

Based on the current plan and evidence, the workflow fragment is **not production-ready yet**. The
largest blockers are:

1. deterministic internal `BUFFERED_PUMP_SCOPE_ALREADY_OPEN` terminal errors under
   duplicate/concurrent event storms;
2. retry attempt overflow (`attempts > maxAttempts`) observed in scenario smoke;
3. concurrent migration startup failures on fresh Postgres databases;
4. incomplete production harness coverage: no dedicated deterministic smoke app, no MySQL/SQLite
   lanes, no mock external service, no cross-backend normalized-state comparison, and limited
   destructive DB/process fault coverage.

The passing Postgres smoke runs are encouraging for basic lifecycle and dispatcher recovery, but
they do not meet the release bar in `TESTING_PLAN.md`.

### 2026-05-31 follow-up investigation: cursor precision, skew dispatchers, and harness isolation

Scope: report-only for product behavior. Smoke harness change made: recreated/fixed
`confirm-postgres-app.sh` and made it launch React Router with `--port $PORT --strictPort` so it
fails fast when the requested port is occupied instead of accidentally validating against a
different already-running app.

#### Additional passing evidence

- `PORT=5174 confirm-postgres-app.sh create-race.js` passed on fresh DB
  `fragno_wf_confirm_20260531_171710_3957`.
- With the app internal dispatcher disabled and two external normal dispatchers, the following
  subset passed before the run reached the pagination script: `create-race.js`,
  `load-concurrency.js`, and `load-parallel.js`.
- With the app internal dispatcher disabled and two skewed external dispatchers
  (`WF_CLOCK_SKEW_MS=60000` and `WF_CLOCK_SKEW_MS=-60000`), both clock-skew scripts passed on fresh
  DB `fragno_wf_skew_20260531_171456_32061`:
  - `clock-skew-retry.js`
  - `clock-skew-timeout.js`
- Sequential repeated migrations on a fresh Postgres database completed 4/4 times; the migration
  blocker remains specifically the concurrent-start case, not normal repeated sequential startup.

#### Finding N: instance-list cursor pagination can skip rows because timestamp cursor values lose Postgres microsecond precision

Reproduction command:

```bash
PORT=5174 packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh history-pagination.js
```

Observed isolated run:

- DB: `fragno_wf_confirm_20260531_171644_29166`
- Script failed with: `completed instance page_mptxajdb_mxdjbu_6 missing from paginated list`.

DB evidence for the seven completed instances:

- `page_mptxajdb_mxdjbu_5`: `updatedAt = 2026-05-31 17:16:49.542048`
- `page_mptxajdb_mxdjbu_2`: `updatedAt = 2026-05-31 17:16:49.541792`
- `page_mptxajdb_mxdjbu_6`: `updatedAt = 2026-05-31 17:16:49.541514`
- `page_mptxajdb_mxdjbu_4`: `updatedAt = 2026-05-31 17:16:49.530639`
- `page_mptxajdb_mxdjbu_1`: `updatedAt = 2026-05-31 17:16:49.529123`
- `page_mptxajdb_mxdjbu_0`: `updatedAt = 2026-05-31 17:16:49.528871`
- `page_mptxajdb_mxdjbu_3`: `updatedAt = 2026-05-31 17:16:49.528557`

API page evidence with `status=complete&pageSize=2`:

1. Page 1 returned ids `..._5`, `..._2` and cursor value for `updatedAt = 2026-05-31T15:16:49.541Z`.
2. Page 2 returned ids `..._4`, `..._1`.
3. Page 3 returned ids `..._0`, `..._3` and ended pagination.
4. Instance `..._6` was skipped.

Interpretation/report:

- The cursor encoded the last row's `updatedAt` only to millisecond precision (`.541Z`), while
  Postgres stored microseconds (`.541792`).
- The next page compared against the rounded/truncated cursor and skipped another row that sorted
  between the true last value and the serialized cursor (`.541514`).
- This is a production-readiness blocker for public list pagination on Postgres. Cursor pagination
  needs a precision-preserving encoding and/or a deterministic tie-breaker in the index/order/cursor
  tuple.

#### Finding O: current-step emissions `once=true` has an empty NDJSON response for terminal/no-emission state

Follow-up evidence for the earlier `retention-gc-check.js` failure:

- Reproduction DB: `fragno_wf_confirm_20260531_171146_16415`.
- Route queried after completing an approval workflow:

```bash
curl -i 'http://localhost:5174/api/workflows/approval-workflow/instances/integrity_mptx453s_m6mhef/current-step/emissions?once=true'
```

Observed response:

- HTTP `200`
- `content-type: application/x-ndjson; charset=utf-8`
- empty body

Interpretation/report:

- The route contract declares an array output, while the implementation uses `jsonStream` and writes
  zero NDJSON records for an empty `once=true` snapshot.
- The smoke helper therefore parses the empty body as `null`, causing `retention-gc-check.js` to
  fail on `.length`.
- This may be an API contract/implementation mismatch rather than a core workflow-state bug, but it
  is still a production API usability issue until either the route returns `[]` for `once=true` or
  the public contract explicitly documents NDJSON streaming semantics and empty-body behavior.

#### Finding P: scenario-matrix retry overflow reproduced again on a fresh isolated DB

Reproduction command:

```bash
PORT=5174 packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh scenario-matrix.js
```

Observed run:

- DB: `fragno_wf_confirm_20260531_171248_24943`
- Script reported two anomalies:
  - `parallel sm_par_mptx5h6e_2 exceeded attempts on do:fetch-user`
  - `parallel sm_par_mptx5h6e_3 exceeded attempts on do:fetch-user`

DB evidence:

- Both overflow rows had `stepKey = do:fetch-user`, `status = errored`, `attempts = 6`,
  `maxAttempts = 5`, `errorMessage = FLAKY_USER_FETCH`.

Interpretation/report:

- This confirms the earlier retry-accounting finding on a fresh isolated run. It is not just
  contamination from previous scripts sharing a database.

#### Harness note: strict port binding matters

While investigating `history-pagination.js`, an orphaned wf-example dev server on port `5174` caused
one attempted confirmation run to start a new server on `5177` while the readiness probe still
succeeded against the old `5174` process. `confirm-postgres-app.sh` now passes
`--port $PORT --strictPort` to React Router so this class of false validation fails immediately
instead of mixing databases/processes.

### 2026-06-01 follow-up investigation: dispatcher catch-up and API validation behavior

Scope: report-only for product behavior. Smoke artifact additions/fixes made during this pass:

- Added `api-route-validation.js` to cover workflow-list and route/input validation behavior through
  the public API.
- Updated `confirm-postgres-app.sh` cleanup to recursively kill the React Router child process as
  well as the parent `pnpm` process; previous failed/manual runs could leave an orphaned server on
  `5174`.

Validation command:

```bash
PORT=5174 packages/fragment-workflows/workflows-smoke-artifacts/confirm-postgres-app.sh api-route-validation.js
```

Observed passing run:

- DB: `fragno_wf_confirm_20260601_094829_23850`
- `GET /` listed all configured workflows.
- Unknown workflow create/event requests returned `404 WORKFLOW_NOT_FOUND`.
- Missing event `type` returned `400 FRAGNO_VALIDATION_ERROR` rather than `500`.
- The script completed and the temporary DB was dropped.

#### Finding Q: queued events while no dispatcher is polling can still hit `BUFFERED_PUMP_SCOPE_ALREADY_OPEN` after dispatcher recovery

Manual reproduction shape:

1. Start `wf-example` with `WF_DISABLE_INTERNAL_DISPATCHER=1` on a fresh Postgres DB.
2. Create 5 `approval-workflow` instances.
3. Before starting an external dispatcher, send one `approval` and one `fulfillment` event to each
   instance.
4. Start `workflows-smoke-artifacts/dispatcher.ts` and wait for recovery.

Observed run:

- DB retained: `fragno_wf_catchupfail_20260531_184318_1566`
- Before starting the external dispatcher, instance statuses were mixed: three `waiting`, two
  `active`.
- After starting the dispatcher and waiting ~30s:
  - `catchup_mpu0dva4_r6n0o2_0`: `complete`
  - `catchup_mpu0dva4_r6n0o2_1`: `errored`, `errorMessage = BUFFERED_PUMP_SCOPE_ALREADY_OPEN`
  - `catchup_mpu0dva4_r6n0o2_2`: `errored`, `errorMessage = BUFFERED_PUMP_SCOPE_ALREADY_OPEN`
  - `catchup_mpu0dva4_r6n0o2_3`: `errored`, `errorMessage = BUFFERED_PUMP_SCOPE_ALREADY_OPEN`
  - `catchup_mpu0dva4_r6n0o2_4`: `errored`, `errorMessage = BUFFERED_PUMP_SCOPE_ALREADY_OPEN`

DB evidence:

- The completed instance consumed exactly one approval and one fulfillment event.
- Each errored instance had exactly one persisted approval event and one persisted fulfillment
  event, but both were unconsumed.
- Each errored instance still had only `waitForEvent:approval` in `workflow_step`, with step status
  `waiting`.

Interpretation/report:

- This extends the event-storm finding: the buffered-pump scope collision is not limited to high
  duplicate counts. It can also happen with one event of each type per instance when events are
  queued while no dispatcher is polling and then an external dispatcher catches up.
- This is a durability/product-readiness blocker for deployments that intentionally run API
  processes without internal dispatchers and rely on external worker catch-up.

#### Finding R: route input-schema validation returns framework-level `FRAGNO_VALIDATION_ERROR` instead of route-declared error codes

Observed in `api-route-validation.js`:

- Creating an instance with an invalid ID (`bad/slash`) returned:
  - HTTP `400`
  - `code = FRAGNO_VALIDATION_ERROR`
  - zod issue details containing the identifier regex.
- Missing event `type` similarly returned `400 FRAGNO_VALIDATION_ERROR`.

Interpretation/report:

- The workflow routes declare domain error codes such as `INVALID_INSTANCE_ID`, but input-schema
  validation can fail before the route handler reaches `assertIdentifier`, producing a
  framework-level validation code instead.
- This may be acceptable if documented as the public validation contract, but the current route
  `errorCodes` list does not make that behavior obvious to API consumers.
- Production release should either document `FRAGNO_VALIDATION_ERROR` for schema-level failures or
  align route schemas/handlers so declared domain error codes are consistently returned.

#### Finding S: batch create silently deduplicates duplicate IDs inside the same request

Observed in `api-route-validation.js`:

```json
{
  "instances": [
    {
      "id": "api_..._batch_dup",
      "params": { "requestId": "r1", "amount": 1, "requestedBy": "api" }
    },
    {
      "id": "api_..._batch_dup",
      "params": { "requestId": "r2", "amount": 2, "requestedBy": "api" }
    }
  ]
}
```

Response:

- HTTP `200`
- one created instance in the response, not two;
- no explicit duplicate-ID warning/error.

Interpretation/report:

- This is not necessarily a correctness bug, but it is an important public API behavior to document
  and guard with tests.
- If callers expect response cardinality to match request cardinality, the current behavior is
  surprising. The release gate should decide whether same-batch duplicates should be rejected,
  reported per item, or explicitly documented as idempotent deduplication.

#### Coverage gap: example approval params are not runtime-validated

`api-route-validation.js` sent structurally incomplete approval params (`{ "requestId": "r" }`) and
the example app accepted them with HTTP `200` / `status = active`.

Interpretation/report:

- This appears to be a coverage/example limitation rather than a route failure: the current example
  workflows are TypeScript-typed but do not provide runtime schemas for params.
- It reinforces the `TESTING_PLAN.md` requirement for a dedicated schema-validation smoke workflow
  with invalid params/output assertions.

### 2026-06-01 follow-up investigation: API scoping and terminal management edge cases

Scope: report-only. No workflow implementation or smoke artifact changes were made in this pass. A
one-off fresh-Postgres probe was run against `wf-example` on `PORT=5174`.

Observed run:

- DB: `fragno_wf_probe_20260601_144702_221` (temporary DB dropped after the probe)
- App log: `/tmp/wf-probe-app-probe_20260601_144702_221.log`

Positive checks from the same probe:

- `GET /approval-workflow/instances/not_here` returned `404 INSTANCE_NOT_FOUND`.
- `GET /approval-workflow/instances?cursor=not-a-valid-cursor` returned `400 INVALID_CURSOR`.
- Sending an `approval` event while an instance was paused persisted the event but did not consume
  it while paused:
  - paused status stayed `paused` after ~2.5s;
  - approval event count was `1`;
  - consumed approval count while paused was `0`.
- After `resume`, the previously queued approval event was consumed and the workflow advanced to
  `sleep:cooldown`.

#### Finding T: public instance IDs are globally unique across workflows despite workflow-scoped routes

Probe shape:

1. Create `approval-workflow` instance with ID `probe_mpv7dva3_3tigyc_shared`.
2. Create `demo-data-workflow` instance with the same public ID.

Observed response:

```json
{
  "first": {
    "status": 200,
    "body": { "id": "probe_mpv7dva3_3tigyc_shared", "details": { "status": "active" } }
  },
  "second": {
    "status": 409,
    "body": { "message": "Instance already exists", "code": "INSTANCE_ID_ALREADY_EXISTS" }
  }
}
```

Static source context:

- `workflow_instance` defines a unique index on `(workflowName, id)`, but the external `idColumn()`
  also creates a global unique constraint on `id` in Postgres (`workflow_instance_id_key` was
  visible in `\d workflows.workflow_instance` during earlier DB inspection).
- Routes are shaped as `/:workflowName/instances/:instanceId`, which suggests workflow-scoped
  identifiers to API consumers.

Interpretation/report:

- This may be intentional if workflow instance IDs are meant to be globally unique across the entire
  workflows fragment, but the route shape and `(workflowName, id)` index imply that same-ID
  instances under different workflows might be valid.
- If global uniqueness is intended, it should be documented explicitly and the redundant
  workflow-name/id unique index may be misleading.
- If workflow-scoped uniqueness is intended, the current schema/API behavior prevents it and blocks
  the planned security test for “workflow A events cannot affect workflow B even with matching
  instance IDs.”

#### Finding U: `resume` is a successful no-op on terminal instances while other terminal mutators return `INSTANCE_TERMINAL`

Probe shape:

1. Complete an `approval-workflow` instance.
2. Call terminal-state management/event routes against the completed instance.

Observed response:

```json
{
  "termStatus": { "status": "complete" },
  "postTerminal": {
    "pause": {
      "status": 409,
      "body": { "message": "Instance is terminal", "code": "INSTANCE_TERMINAL" }
    },
    "resume": { "status": 200, "body": { "ok": true } },
    "terminate": {
      "status": 409,
      "body": { "message": "Instance is terminal", "code": "INSTANCE_TERMINAL" }
    },
    "event": {
      "status": 409,
      "body": { "message": "Instance is terminal", "code": "INSTANCE_TERMINAL" }
    }
  }
}
```

Static source context:

- `pauseInstance` explicitly throws `INSTANCE_TERMINAL` for terminal statuses.
- `terminateInstance` and `sendEvent` also reject terminal instances.
- `resumeInstance` returns the current instance status whenever the current status is not `paused`;
  this includes terminal states.

Interpretation/report:

- This is an API consistency issue: all other mutating operations reject terminal instances, but
  `resume` reports success even though the instance is terminal and cannot be resumed.
- It may be acceptable as an idempotent no-op, but then the contract should document that `resume`
  differs from `pause`, `terminate`, and `send-event` on terminal instances.
- If the production-readiness bar expects “terminal-state errors” consistently across management
  routes, `resume` should be covered by explicit tests and either documented or aligned.

#### Additional validation-surface note: batch max-size failure uses framework validation code

The same probe submitted 101 batch-create items. The route returned HTTP `400` with
`code = FRAGNO_VALIDATION_ERROR` and a zod `too_big` issue, not a workflow-domain code.

This is consistent with Finding R rather than a separate product finding, but it adds batch max-size
behavior to the list of route-level errors that need contract documentation.
