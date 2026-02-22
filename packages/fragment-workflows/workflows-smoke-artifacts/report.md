# Workflows Smoke Test Report (2026-02-02)

## Environment

- Repo: /Users/wilco/.superset/worktrees/fragno/workflows-smoke-test
- Example app: `example-apps/wf-example` via `pnpm --filter @fragno-example/wf-example dev`
- Base URL used: `http://localhost:5173/api/workflows`
- Workflow CLI: `apps/fragno-wf` built via `pnpm --filter @fragno-dev/fragno-wf build`
- Added test workflow: `wait-timeout-workflow` (waitForEvent timeout edge tests)
- Added test workflow: `crash-test-workflow` (long-running step for crash recovery tests)
- Optional env: `WF_DISABLE_INTERNAL_DISPATCHER=1` to keep API server up while managing dispatchers
  externally

## Manual checks completed

- `fragno-wf workflows list` returns expected workflows.
- `instances create`, `get`, `history`, `logs`, `send-event`, `pause/resume` all functioned normally
  for single instances.
- Crash tests (no new issues): app server crash mid-step recovered after lease expiry; dispatcher
  SIGKILL during processing + events while down recovered after restart.
- Event duplication/idempotency checks (new script `duplicate-event-idempotency.js`) completed with
  no issues; example history for `dup_ml5gjane_0` shows 3 duplicate `approval` events where only one
  had `consumedByStepKey=approval`, and a single `fulfillment` event consumed after restart
  (runNumber 1).
- API cancellation semantics (no new issues): `pause-resume-race.js` completed with no stuck paused
  instances; `terminate-running-parallel.js` reported no overwrites (all terminated instances stayed
  terminated).
- Large payload handling (no new issues): `large-payload.js` ran with 256 KB params + 256 KB
  approval/fulfillment payloads; DB shows full byte lengths for params/output/events (see evidence
  below for instance `large_ml5hhgm0`).
- Concurrency + authorization hooks (no new issues): ran `auth-hook-concurrency.js` with
  `WF_AUTH_REJECT_PCT=30` and concurrent create/pause/resume/send-event calls; rejected requests
  left no DB mutations (see evidence below).
- Migration edge cases (no new issues): concurrent `migrate()` calls succeeded while two dispatchers
  were polling; no errors in logs, no duplicate indexes, schema version unchanged (see evidence
  below).

## Evidence (Large Payload Handling)

Instance: `large_ml5hhgm0` (2026-02-02)

```sql
SELECT
  octet_length (params ->> 'largeParam') AS large_param_bytes,
  octet_length (output -> 'request' ->> 'largeParam') AS output_param_bytes
FROM
  "workflow_instance_workflows"
WHERE
  "instanceId" = 'large_ml5hhgm0';
```

Result:

```
 large_param_bytes | output_param_bytes
-------------------+--------------------
            262144 |             262144
```

```sql
SELECT
  type,
  octet_length (payload ->> 'note') AS note_bytes,
  octet_length (payload ->> 'blob') AS blob_bytes
FROM
  "workflow_event_workflows"
WHERE
  "instanceId" = 'large_ml5hhgm0'
ORDER BY
  "createdAt";
```

Result:

```
    type     | note_bytes | blob_bytes
-------------+------------+------------
 approval    |     262144 |
 fulfillment |            |     262144
```

## Evidence (Migration Edge Cases)

Environment (2026-02-02):

- App server started with migrations enabled (auto-selected port `http://localhost:5179/` due to
  existing ports).
- Two dispatchers active, each calls `migrate()` on startup.
- Three concurrent migration workers started via `migration-edge.ts`.

Logs:

```
[migration-edge] start pid=79000
[migration-edge] complete pid=79000 elapsedMs=13
[migration-edge] start pid=78999
[migration-edge] complete pid=78999 elapsedMs=11
[migration-edge] start pid=78998
[migration-edge] complete pid=78998 elapsedMs=14
```

Schema version:

```sql
SELECT
  *
FROM
  fragno_db_settings;
```

Result:

```
           id           |           key            | value | _internalId | _version
------------------------+--------------------------+-------+-------------+----------
 W7w3GeEu-1_ZEtXHkN5iFA | .schema_version          | 2     |           1 |        0
 mwAMQdhMeRoUfE3dt5uN0g | workflows.schema_version | 9     |           2 |        0
```

Duplicate index check:

```sql
SELECT
  indexname,
  count(*)
FROM
  pg_indexes
WHERE
  schemaname = 'public'
GROUP BY
  indexname
HAVING
  count(*) > 1;
```

Result:

```
 indexname | count
-----------+-------
(0 rows)
```

## Evidence (Concurrency + Authorization Hooks)

Environment (2026-02-02):

- Example app started with `WF_AUTH_REJECT_PCT=30` (random 30% reject).
- Base URL: `http://localhost:5180/api/workflows`

Command:

```bash
BASE_URL=http://localhost:5180/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/auth-hook-concurrency.js
```

Output summary (run `ml5hpy93`):

```
create: ok=14 unauthorized=16 otherErrors=0
pause: ok=3 unauthorized=11 otherErrors=0
resume: ok=6 unauthorized=8 otherErrors=0
approval: ok=9 unauthorized=5 otherErrors=0
fulfillment: ok=7 unauthorized=7 otherErrors=0
```

DB checks (rejected create left no instance rows):

```sql
SELECT
  count(*) AS unauthorized_create_instances
FROM
  "workflow_instance_workflows"
WHERE
  "instanceId" IN (
    'auth_ml5hpy93_0',
    'auth_ml5hpy93_2',
    'auth_ml5hpy93_5',
    'auth_ml5hpy93_6',
    'auth_ml5hpy93_8',
    'auth_ml5hpy93_10',
    'auth_ml5hpy93_13',
    'auth_ml5hpy93_15',
    'auth_ml5hpy93_16',
    'auth_ml5hpy93_18',
    'auth_ml5hpy93_20',
    'auth_ml5hpy93_21',
    'auth_ml5hpy93_23',
    'auth_ml5hpy93_25',
    'auth_ml5hpy93_27',
    'auth_ml5hpy93_29'
  );
```

Result:

```
 unauthorized_create_instances
------------------------------
                            0
```

DB checks (rejected approval/fulfillment left no event rows):

```sql
SELECT
  i."instanceId",
  coalesce(
    count(e.*) FILTER (
      WHERE
        e.type = 'approval'
    ),
    0
  ) AS approval_events
FROM
  "workflow_instance_workflows" i
  LEFT JOIN "workflow_event_workflows" e ON e."instanceId" = i."instanceId"
WHERE
  i."instanceId" IN (
    'auth_ml5hpy93_9',
    'auth_ml5hpy93_11',
    'auth_ml5hpy93_22',
    'auth_ml5hpy93_26',
    'auth_ml5hpy93_28'
  )
GROUP BY
  i."instanceId"
ORDER BY
  i."instanceId";
```

Result:

```
    instanceId    | approval_events
------------------+-----------------
 auth_ml5hpy93_11 |               0
 auth_ml5hpy93_22 |               0
 auth_ml5hpy93_26 |               0
 auth_ml5hpy93_28 |               0
 auth_ml5hpy93_9  |               0
```

```sql
SELECT
  i."instanceId",
  coalesce(
    count(e.*) FILTER (
      WHERE
        e.type = 'fulfillment'
    ),
    0
  ) AS fulfillment_events
FROM
  "workflow_instance_workflows" i
  LEFT JOIN "workflow_event_workflows" e ON e."instanceId" = i."instanceId"
WHERE
  i."instanceId" IN (
    'auth_ml5hpy93_1',
    'auth_ml5hpy93_4',
    'auth_ml5hpy93_9',
    'auth_ml5hpy93_11',
    'auth_ml5hpy93_17',
    'auth_ml5hpy93_19',
    'auth_ml5hpy93_22'
  )
GROUP BY
  i."instanceId"
ORDER BY
  i."instanceId";
```

Result:

```
    instanceId    | fulfillment_events
------------------+--------------------
 auth_ml5hpy93_1  |                  0
 auth_ml5hpy93_11 |                  0
 auth_ml5hpy93_17 |                  0
 auth_ml5hpy93_19 |                  0
 auth_ml5hpy93_22 |                  0
 auth_ml5hpy93_4  |                  0
 auth_ml5hpy93_9  |                  0
```

## Bugs Found

### 1) Batch create endpoint hangs with non-empty payload

**Severity:** High (blocks batch instance creation)

**Repro steps:**

1. Start the workflows example app:
   ```bash
   pnpm --filter @fragno-example/wf-example dev
   ```
2. Call batch create with any non-empty `instances` array (example):
   ```bash
   curl -X POST http://localhost:5174/api/workflows/approval-workflow/instances/batch \
     -H 'content-type: application/json' \
     -d '{"instances":[{"id":"batchtest1"}]}'
   ```
3. Observe that the request never returns (client times out after 5–20s).
4. Confirm instance was not created:
   ```bash
   curl http://localhost:5174/api/workflows/approval-workflow/instances/batchtest1
   # => {"message":"Instance not found","code":"INSTANCE_NOT_FOUND"}
   ```

**Expected:**

- API responds quickly with:
  ```json
  { "instances": [{ "id": "batchtest1", "details": { "status": "active" } }] }
  ```

**Actual:**

- Request hangs indefinitely (no response within 20s).
- No instance is created.

**Notes:**

- This reproduces consistently with 1+ instances.
- An empty array _does_ return immediately: `{ "instances": [] }`.
- Single-instance create (`POST /:workflowName/instances`) works normally.
- Repro persists even after stopping additional dispatcher processes.

### 2) Parallel-steps workflow can stall retries for minutes (pending task left with stale lease)

**Severity:** High (workflows stall far beyond retry schedule; requires external tick to recover)

**Repro steps:**

1. Start the workflows example app (Postgres on port 5436):
   ```bash
   pnpm --filter @fragno-example/wf-example dev
   ```
2. Start additional dispatcher processes (to simulate concurrent dispatchers):
   ```bash
   NODE_OPTIONS=--conditions=development tsx packages/fragment-workflows/workflows-smoke-artifacts/dispatcher.ts
   NODE_OPTIONS=--conditions=development tsx packages/fragment-workflows/workflows-smoke-artifacts/dispatcher.ts
   ```
3. Run the parallel-steps load script (10 concurrent instances):
   ```bash
   BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/load-parallel.js
   ```

**Expected:**

- Each instance completes in ~10–20s (fetch-todo retries every 2s, fetch-user retries every 400ms).

**Actual:**

- 2/10 instances remained stuck >90s. Status showed `waiting` with current step `fetch-user` still
  `running`, while `fetch-todo` was waiting for a retry that never triggered.
- Example instance status while stuck:
  ```
  Status: waiting
  Current step: fetch-user (running, attempts 2/5)
  ```
- History showed:
  ```
  fetch-user ... do running 2/5
  fetch-todo ... do waiting 2/7 retry:2026-02-02T15:05:30.994Z
  ```
- Postgres task row showed `status = pending` **but** `lockedUntil` still set in the past/future
  (stale lease), preventing the pending task from being claimed until some unrelated hook tick
  fired.
- The stuck instances only errored ~9 minutes later (at ~15:14:46Z) with `FLAKY_USER_FETCH`, far
  beyond the expected retry schedule.

**Notes:**

- This appears to be a race between the task lease heartbeat and task rescheduling: the heartbeat
  updates `lockedUntil` after the task has been set back to `pending`, leaving a pending task with
  an active lease and no subsequent tick scheduled to pick it up when the lease expires.
- A manual `/api/workflows/_runner/tick` returned `processed: 0` while tasks were pending.

### 3) Retry limits exceeded under concurrent dispatchers (attempts > maxAttempts)

**Severity:** High (retry/backoff guarantees violated; steps run more times than configured)

**Repro steps:**

1. Start the workflows example app (Postgres on port 5436):
   ```bash
   pnpm --filter @fragno-example/wf-example dev
   ```
2. Start multiple dispatcher processes:
   ```bash
   NODE_OPTIONS=--conditions=development tsx packages/fragment-workflows/workflows-smoke-artifacts/dispatcher.ts
   NODE_OPTIONS=--conditions=development tsx packages/fragment-workflows/workflows-smoke-artifacts/dispatcher.ts
   ```
3. Run the parallel-steps load script (10 concurrent instances):
   ```bash
   BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/load-parallel.js
   ```
4. Inspect history for any instances that errored on `fetch-user`:
   ```bash
   curl -s http://localhost:5173/api/workflows/parallel-steps-workflow/instances/par_ml5bt1vr_8/history
   ```
   Example output shows attempts > max:
   ```
   "stepKey":"fetch-user", "status":"errored", "attempts":9, "maxAttempts":5
   ```

**Expected:**

- `attempts` should never exceed `maxAttempts` (5 for `fetch-user`, 7 for `fetch-todo`).

**Actual:**

- `fetch-user` steps reached attempts 6–9 with `maxAttempts: 5` on multiple instances in the same
  run (example: `par_ml5bt1vr_8`).

**Notes:**

- This only appeared once multiple dispatchers were actually running.
- Likely caused by concurrent dispatchers picking the same step/task and incrementing attempts
  independently.

### 4) waitForEvent timeout is soft: events after deadline still complete

**Severity:** Medium (timeouts are not strictly enforced; late events can be accepted)

**Repro steps:**

1. Use the added wait-timeout workflow (`wait-timeout-workflow`), which waits for `edge` events with
   a `2 s` timeout.
2. Run the edge timing script:
   ```bash
   BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/wait-timeout-edge.js
   ```
3. The script waits for the instance to reach `waiting`, then sends some events **after**
   `timeoutMs + 150ms`.

**Expected:**

- Events sent after the timeout should be ignored and instances should error with
  `WaitForEventTimeoutError`.

**Actual:**

- Several instances completed successfully even though the event timestamp is **after** the timeout
  wakeAt. Example (`edge_after_ml5cldwa_7`):
  - `wakeAt`: `2026-02-02T15:52:06.284Z`
  - event payload `sentAt`: `2026-02-02T15:52:06.559Z` (≈275ms after wakeAt)
  - instance completed at `2026-02-02T15:52:06.999Z`

**Notes:**

- This suggests the timeout is only enforced when the timeout task is processed; events arriving
  after the deadline but before the timeout tick still complete.

### 5) Runner tick storms can leave a pending task with an active lease (instance stalls until manual tick)

**Severity:** High (concurrent tick calls fail to advance pending work; can stall workflows)

**Repro steps:**

1. Start the workflows example app:
   ```bash
   WF_EXAMPLE_DATABASE_URL=postgres://postgres:postgres@localhost:5436/wilco pnpm --filter @fragno-example/wf-example dev
   ```
2. Run the tick storm script:
   ```bash
   BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/runner-tick-storm.js
   ```

**Expected:**

- Concurrent `_runner/tick` calls should safely advance pending tasks.
- No pending task should retain a non-null `lockedUntil`.
- All instances should complete without manual intervention.

**Actual:**

- The tick storm reported `processed 0` for all 5 rounds and timed out waiting for one instance:
  ```
  Timed out waiting for 1 instances
  - tick_ml5g7wlh_2
  ```
- Instance status remained `waiting` with `fetch-user` still `running`:
  ```
  Status: waiting
  Current step: fetch-user (running, attempts 2/5)
  ```
- History showed `fetch-todo` in `waiting` with a retry scheduled:
  ```
  fetch-todo ... waiting (attempts 2/7) nextRetryAt: 2026-02-02T17:33:37.558Z
  ```
- Postgres showed a **pending** task with a non-null lease:
  ```sql
  SELECT
    id,
    status,
    "lockedUntil",
    "runNumber",
    attempts,
    "maxAttempts",
    "runAt",
    "updatedAt"
  FROM
    "workflow_task_workflows"
  WHERE
    "instanceId" = 'tick_ml5g7wlh_2';
  ```
  Result:
  ```
  status  | lockedUntil              | runAt
  pending | 2026-02-02 18:34:35.6    | 2026-02-02 18:33:37.558
  ```

### 6) History pagination returns 500 when requesting steps page 2

**Severity:** High (breaks history pagination and blocks parity checks vs DB)

**Repro steps:**

1. Ensure the workflows example app is running:
   ```bash
   pnpm --filter @fragno-example/wf-example dev
   ```
2. Run the history pagination script:
   ```bash
   node packages/fragment-workflows/workflows-smoke-artifacts/history-pagination.js
   ```

**Expected:**

- `/history` accepts `stepsCursor` and returns the next page without errors.

**Actual:**

- Second page request fails with 500. Example failure (two consecutive runs, different instance
  IDs):
  ```
  GET /approval-workflow/instances/hist_ml5h9yem/history?pageSize=2&order=asc&includeLogs=false&stepsCursor=eyJ2IjoxLCJpbmRleE5hbWUiOiJpZHhfd29ya2Zsb3dfc3RlcF9oaXN0b3J5X2NyZWF0ZWRBdCIsIm9yZGVyRGlyZWN0aW9uIjoiYXNjIiwicGFnZVNpemUiOjIsImluZGV4VmFsdWVzIjp7IndvcmtmbG93TmFtZSI6ImFwcHJvdmFsLXdvcmtmbG93IiwiaW5zdGFuY2VJZCI6Imhpc3RfbWw1aDl5ZW0iLCJydW5OdW1iZXIiOjAsImNyZWF0ZWRBdCI6IjIwMjYtMDItMDJUMTg6MDM6MDguMDk0WiJ9fQ%3D%3D -> 500
  GET /approval-workflow/instances/hist_ml5ha3nk/history?pageSize=2&order=asc&includeLogs=false&stepsCursor=eyJ2IjoxLCJpbmRleE5hbWUiOiJpZHhfd29ya2Zsb3dfc3RlcF9oaXN0b3J5X2NyZWF0ZWRBdCIsIm9yZGVyRGlyZWN0aW9uIjoiYXNjIiwicGFnZVNpemUiOjIsImluZGV4VmFsdWVzIjp7IndvcmtmbG93TmFtZSI6ImFwcHJvdmFsLXdvcmtmbG93IiwiaW5zdGFuY2VJZCI6Imhpc3RfbWw1aGEzbmsiLCJydW5OdW1iZXIiOjAsImNyZWF0ZWRBdCI6IjIwMjYtMDItMDJUMTg6MDM6MTQuODg5WiJ9fQ%3D%3D -> 500
  ```

**Notes:**

- The error happens on the second page when a `stepsCursor` is provided.
- The script never reaches events/logs pagination because the request errors out.

### 6) waitForEvent timeouts delayed by clock-skewed dispatchers

**Severity:** High (timeouts depend on dispatcher clock; can be delayed ~1 minute with 60s skew)

**Repro steps:**

1. Start the workflows example app with internal dispatcher disabled:
   ```bash
   WF_DISABLE_INTERNAL_DISPATCHER=1 pnpm --filter @fragno-example/wf-example dev
   ```
2. Start two skewed dispatchers (+60s and -60s):
   ```bash
   WF_CLOCK_SKEW_MS=60000 NODE_OPTIONS=--conditions=development tsx packages/fragment-workflows/workflows-smoke-artifacts/dispatcher-skew.ts
   WF_CLOCK_SKEW_MS=-60000 NODE_OPTIONS=--conditions=development tsx packages/fragment-workflows/workflows-smoke-artifacts/dispatcher-skew.ts
   ```
3. Run the timeout skew script:
   ```bash
   BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/clock-skew-timeout.js
   ```

**Expected:**

- `waitForEvent` timeouts should fire near the step `wakeAt` (~2s after waiting), independent of
  dispatcher clock skew.

**Actual:**

- All 6 instances timed out ~58–59s late (roughly matching the +60s skew). Example output:
  ```
  Timeout skew violations: 6
  - skew_timeout_ml5h03py_0: deltaMs=58617 wakeAt=2026-02-02T17:55:30.380Z updatedAt=2026-02-02T17:56:28.997Z
  - skew_timeout_ml5h03py_1: deltaMs=58613 wakeAt=2026-02-02T17:55:30.386Z updatedAt=2026-02-02T17:56:28.999Z
  ```

**Notes:**

- This indicates timeout scheduling is tied to dispatcher wall clock instead of workflow schedule
  time.
- A manual `_runner/tick` (`processed: 1`) immediately advanced the workflow to terminal
  (`errored`), indicating the instance was stalled until an external tick ran.

**Notes:**

- This mirrors the stale lease behavior seen in parallel-step retries, but here it was triggered by
  a burst of concurrent `_runner/tick` calls.

### 6) DB restart mid-transaction crashes API server (unhandled pg pool error)

**Severity:** High (availability regression during DB restarts)

**Repro steps:**

1. Start the workflows example app, logging output:
   ```bash
   WF_EXAMPLE_DATABASE_URL=postgres://postgres:postgres@localhost:5436/wilco pnpm --filter @fragno-example/wf-example dev > /tmp/wf-example.log 2>&1
   ```
2. Run the DB restart script (creates `crash-test-workflow` instances and restarts Postgres 2s into
   the run):
   ```bash
   BASE_URL=http://localhost:5173/api/workflows node packages/fragment-workflows/workflows-smoke-artifacts/db-restart-mid-transaction.js
   ```
3. Observe the app process exits and the API port stops listening.

**Expected:**

- The API server should tolerate a Postgres restart without crashing, reconnecting once the DB is
  back.
- Workflows should continue (or retry) without requiring a manual app restart.

**Actual:**

- The app exits with an unhandled `pg` pool error as soon as Postgres is stopped:
  ```
  node:events:486
        throw er; // Unhandled 'error' event
  error: terminating connection due to administrator command
  ...
  severity: 'FATAL',
  code: '57P01'
  ```
- `pnpm --filter @fragno-example/wf-example dev` exits; port 5173 is no longer listening until
  manually restarted.

**Notes:**

- The workflow instances themselves reached `complete` after the DB was back, but the API server did
  not recover without a manual restart.

### 7) Retention/GC not enforced (retentionUntil never set; no GC tasks scheduled)

**Severity:** Medium (retention policy appears unimplemented; completed instances never become
eligible for cleanup)

**Repro steps:**

1. Create a workflow instance that completes automatically:
   ```bash
   curl -s -X POST http://localhost:5173/api/workflows/demo-data-workflow/instances \
     -H 'content-type: application/json' \
     -d '{}'
   ```
2. Wait until the instance reaches `complete`.
3. Query the instance row for `retentionUntil`:
   ```sql
   SELECT
     "workflowName",
     "instanceId",
     status,
     "retentionUntil",
     "completedAt"
   FROM
     "workflow_instance_workflows"
   WHERE
     "instanceId" = 'inst_ml5h24xf_hcfmuw60';
   ```
4. Check whether any GC tasks are scheduled:
   ```sql
   SELECT
     kind,
     count(*)
   FROM
     "workflow_task_workflows"
   GROUP BY
     kind
   ORDER BY
     kind;
   ```

**Expected:**

- When a retention window is configured (or by default), completed instances should have a non-null
  `retentionUntil`.
- A GC task should eventually be scheduled to remove expired instances and related rows.

**Actual:**

- `retentionUntil` remains `NULL` even after completion:
  ```
  demo-data-workflow | inst_ml5h24xf_hcfmuw60 | complete | (null) | 2026-02-02 18:57:07.705
  ```
- No GC tasks are present; only `wake` tasks exist:
  ```
  kind | count
  ----+------
  wake | 22
  ```

**Notes:**

- There is a `retentionUntil` column in the schema, but no code path appears to set it or schedule
  `gc` tasks.
- Without a configured retention policy, the GC correctness scenario cannot be fully exercised.

**Evidence (2026-02-02, current run):**

- Instance created: `inst_ml5hj06i_oktd5tfq` (`demo-data-workflow`, completed with error).
- `retentionUntil` still `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'inst_ml5hj06i_oktd5tfq';
  ```
  Result:
  ```
   demo-data-workflow | inst_ml5hj06i_oktd5tfq | errored | (null) | 2026-02-02 19:10:16.38
  ```
- No GC tasks scheduled:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 2
  ```

**Evidence (2026-02-02, latest check):**

- Instance created: `inst_ml5hsqt8_do24wr95` (`demo-data-workflow`, errored).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'inst_ml5hsqt8_do24wr95';
  ```
  Result:
  ```
   demo-data-workflow | inst_ml5hsqt8_do24wr95 | errored | (null) | 2026-02-02 19:17:48.74
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 11
  ```

**Evidence (2026-02-02, current check):**

- Instance created: `inst_ml5hut3m_9qu6hiay` (`demo-data-workflow`, errored).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'inst_ml5hut3m_9qu6hiay';
  ```
  Result:
  ```
   demo-data-workflow | inst_ml5hut3m_9qu6hiay | errored | (null) | 2026-02-02 19:19:26.825
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 11
  ```

**Evidence (2026-02-02, retention/GC re-check):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5hw8rx` (`demo-data-workflow`, complete).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5hw8rx';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5hw8rx | complete | (null) | 2026-02-02 19:20:29.872
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 11
  ```

**Evidence (2026-02-02, retention/GC current run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5hxax9` (`demo-data-workflow`, errored).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5hxax9';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5hxax9 | errored | (null) | 2026-02-02 19:21:19.235
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 11
  ```

**Evidence (2026-02-02, retention/GC latest run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5hyely` (`demo-data-workflow`, complete).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5hyely';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5hyely | complete | (null) | 2026-02-02 19:22:08.855
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 11
  ```

**Evidence (2026-02-02, retention/GC current run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5hzdbl` (`demo-data-workflow`, errored).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5hzdbl';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5hzdbl | errored | (null) | 2026-02-02 19:22:55.73
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 11
  ```

**Evidence (2026-02-02, retention/GC latest run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Script timed out waiting for `retention_ml5i3ni7` to reach terminal state.
- Instance remains active:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5i3ni7';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5i3ni7 | active | (null) | (null)
  ```
- Recent completed instances still have `retentionUntil` = `NULL`:
  ```sql
  SELECT
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    status IN ('complete', 'errored', 'terminated')
  ORDER BY
    "completedAt" DESC NULLS LAST
  LIMIT
    5;
  ```
  Result:
  ```
   conc_ml5i2f3c_29 | complete | (null) | 2026-02-02 19:25:22.289
   conc_ml5i2f3c_28 | complete | (null) | 2026-02-02 19:25:22.278
   conc_ml5i2f3c_27 | complete | (null) | 2026-02-02 19:25:20.652
   conc_ml5i2f3c_21 | complete | (null) | 2026-02-02 19:25:20.65
   conc_ml5i2f3c_8  | complete | (null) | 2026-02-02 19:25:20.646
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   run  | 2
   wake | 36
  ```

**Evidence (2026-02-02, retention/GC current run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5i6gq5` (`demo-data-workflow`, complete).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5i6gq5';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5i6gq5 | complete | (null) | 2026-02-02 19:28:24.905
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 37
  ```

**Evidence (2026-02-02, retention/GC latest run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5i7n0j` (`demo-data-workflow`, errored).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5i7n0j';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5i7n0j | errored | (null) | 2026-02-02 19:29:21.549
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 37
  ```

**Evidence (2026-02-02, retention/GC current run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5i92jn` (`demo-data-workflow`, complete).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5i92jn';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5i92jn | complete | (null) | 2026-02-02 19:30:26.44
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 37
  ```

**Evidence (2026-02-02, retention/GC current run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5i9zuc` (`demo-data-workflow`, complete).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5i9zuc';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5i9zuc | complete | (null) | 2026-02-02 19:31:09.578
  ```
- GC tasks still absent (only `wake` tasks observed):
  ```sql
  SELECT
    kind,
    status,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind,
    status
  ORDER BY
    kind,
    status;
  ```
  Result:
  ```
   wake | pending | 29
  ```

### 8) History pagination cursor returns 500 (cannot page beyond first history page)

**Severity:** High (history API breaks with cursors; pagination unusable)

**Repro steps:**

1. Ensure the workflows example app is running (`http://localhost:5173/api/workflows`).
2. Run the new pagination script:
   ```bash
   node packages/fragment-workflows/workflows-smoke-artifacts/history-pagination.js
   ```
3. The script creates an `approval-workflow` instance with many events and requests history with
   `pageSize=2`.
4. The first history page returns cursors; using any cursor (steps/events) yields a 500.

**Expected:**

- `/history` should accept `stepsCursor`/`eventsCursor`/`logsCursor` and return the next page.

**Actual:**

- Requests with a cursor return `500 INTERNAL_SERVER_ERROR`. Example (steps cursor from the first
  page):
  ```bash
  curl -s -w "\nHTTP:%{http_code}\n" \
    "http://localhost:5173/api/workflows/approval-workflow/instances/hist_ml5h829f/history?pageSize=2&order=asc&includeLogs=false&stepsCursor=eyJ2IjoxLCJpbmRleE5hbWUiOiJpZHhfd29ya2Zsb3dfc3RlcF9oaXN0b3J5X2NyZWF0ZWRBdCIsIm9yZGVyRGlyZWN0aW9uIjoiYXNjIiwicGFnZVNpemUiOjIsImluZGV4VmFsdWVzIjp7IndvcmtmbG93TmFtZSI6ImFwcHJvdmFsLXdvcmtmbG93IiwiaW5zdGFuY2VJZCI6Imhpc3RfbWw1aDgyOWYiLCJydW5OdW1iZXIiOjAsImNyZWF0ZWRBdCI6IjIwMjYtMDItMDJUMTg6MDE6MzkuNzc0WiJ9fQ%3D%3D\""
  # => {"error":"Internal server error","code":"INTERNAL_SERVER_ERROR"}
  # => HTTP:500
  ```
  The same occurs with `eventsCursor` from the first page.

**Notes:**

- First page responses include valid-looking base64 cursors, but the follow-up call consistently
  fails with 500.
- This blocks the history pagination correctness scenario (cannot walk cursors forward/backward).

### 9) History pagination still fails on stepsCursor (current run)

**Severity:** High (blocks history pagination checks)

**Evidence (2026-02-02):**

- Command:
  ```bash
  node packages/fragment-workflows/workflows-smoke-artifacts/history-pagination.js
  ```
- Failure output (page 2 for steps cursor):
  ```
  GET /approval-workflow/instances/hist_ml5hb4hw/history?pageSize=2&order=asc&includeLogs=false&stepsCursor=eyJ2IjoxLCJpbmRleE5hbWUiOiJpZHhfd29ya2Zsb3dfc3RlcF9oaXN0b3J5X2NyZWF0ZWRBdCIsIm9yZGVyRGlyZWN0aW9uIjoiYXNjIiwicGFnZVNpemUiOjIsImluZGV4VmFsdWVzIjp7IndvcmtmbG93TmFtZSI6ImFwcHJvdmFsLXdvcmtmbG93IiwiaW5zdGFuY2VJZCI6Imhpc3RfbWw1aGI0aHciLCJydW5OdW1iZXIiOjAsImNyZWF0ZWRBdCI6IjIwMjYtMDItMDJUMTg6MDQ6MDIuNjQwWiJ9fQ%3D%3D -> 500
  ```

**Evidence (2026-02-02, rerun):**

- Command:
  ```bash
  node packages/fragment-workflows/workflows-smoke-artifacts/history-pagination.js
  ```
- Failure output (page 2 for steps cursor):
  ```
  GET /approval-workflow/instances/hist_ml5hc2j8/history?pageSize=2&order=asc&includeLogs=false&stepsCursor=eyJ2IjoxLCJpbmRleE5hbWUiOiJpZHhfd29ya2Zsb3dfc3RlcF9oaXN0b3J5X2NyZWF0ZWRBdCIsIm9yZGVyRGlyZWN0aW9uIjoiYXNjIiwicGFnZVNpemUiOjIsImluZGV4VmFsdWVzIjp7IndvcmtmbG93TmFtZSI6ImFwcHJvdmFsLXdvcmtmbG93IiwiaW5zdGFuY2VJZCI6Imhpc3RfbWw1aGMyajgiLCJydW5OdW1iZXIiOjAsImNyZWF0ZWRBdCI6IjIwMjYtMDItMDJUMTg6MDQ6NDYuNzUxWiJ9fQ%3D%3D -> 500: {"error":"Internal server error","code":"INTERNAL_SERVER_ERROR"}
  ```

**Evidence (2026-02-02, current run):**

- Command:
  ```bash
  node packages/fragment-workflows/workflows-smoke-artifacts/history-pagination.js
  ```
- Failure output (page 2 for steps cursor):
  ```
  GET /approval-workflow/instances/hist_ml5hcymx/history?pageSize=2&order=asc&includeLogs=false&stepsCursor=eyJ2IjoxLCJpbmRleE5hbWUiOiJpZHhfd29ya2Zsb3dfc3RlcF9oaXN0b3J5X2NyZWF0ZWRBdCIsIm9yZGVyRGlyZWN0aW9uIjoiYXNjIiwicGFnZVNpemUiOjIsImluZGV4VmFsdWVzIjp7IndvcmtmbG93TmFtZSI6ImFwcHJvdmFsLXdvcmtmbG93IiwiaW5zdGFuY2VJZCI6Imhpc3RfbWw1aGN5bXgiLCJydW5OdW1iZXIiOjAsImNyZWF0ZWRBdCI6IjIwMjYtMDItMDJUMTg6MDU6MjguMzU5WiJ9fQ%3D%3D -> 500: {"error":"Internal server error","code":"INTERNAL_SERVER_ERROR"}
  ```

**Evidence (2026-02-02, current run):**

- Command:
  ```bash
  node packages/fragment-workflows/workflows-smoke-artifacts/history-pagination.js
  ```
- Failure output (page 2 for steps cursor):
  ```
  GET /approval-workflow/instances/hist_ml5hdzxi/history?pageSize=2&order=asc&includeLogs=false&stepsCursor=eyJ2IjoxLCJpbmRleE5hbWUiOiJpZHhfd29ya2Zsb3dfc3RlcF9oaXN0b3J5X2NyZWF0ZWRBdCIsIm9yZGVyRGlyZWN0aW9uIjoiYXNjIiwicGFnZVNpemUiOjIsImluZGV4VmFsdWVzIjp7IndvcmtmbG93TmFtZSI6ImFwcHJvdmFsLXdvcmtmbG93IiwiaW5zdGFuY2VJZCI6Imhpc3RfbWw1aGR6eGkiLCJydW5OdW1iZXIiOjAsImNyZWF0ZWRBdCI6IjIwMjYtMDItMDJUMTg6MDY6MTYuNjk2WiJ9fQ%3D%3D -> 500: {"error":"Internal server error","code":"INTERNAL_SERVER_ERROR"}
  ```

**Evidence (2026-02-02, current run):**

- Command:
  ```bash
  node packages/fragment-workflows/workflows-smoke-artifacts/history-pagination.js
  ```
- Failure output (page 2 for steps cursor):
  ```
  GET /approval-workflow/instances/hist_ml5hf86v/history?pageSize=2&order=asc&includeLogs=false&stepsCursor=eyJ2IjoxLCJpbmRleE5hbWUiOiJpZHhfd29ya2Zsb3dfc3RlcF9oaXN0b3J5X2NyZWF0ZWRBdCIsIm9yZGVyRGlyZWN0aW9uIjoiYXNjIiwicGFnZVNpemUiOjIsImluZGV4VmFsdWVzIjp7IndvcmtmbG93TmFtZSI6ImFwcHJvdmFsLXdvcmtmbG93IiwiaW5zdGFuY2VJZCI6Imhpc3RfbWw1aGY4NnYiLCJydW5OdW1iZXIiOjAsImNyZWF0ZWRBdCI6IjIwMjYtMDItMDJUMTg6MDc6MTQuMDU5WiJ9fQ%3D%3D -> 500: {"error":"Internal server error","code":"INTERNAL_SERVER_ERROR"}
  ```

### 10) SERIALIZABLE isolation causes 500s on concurrent create (unhandled serialization failures)

**Severity:** High (API 500s under stricter isolation; no retry path)

**Repro steps:**

1. Set DB default isolation to SERIALIZABLE:
   ```sql
   ALTER DATABASE wilco
   SET
     default_transaction_isolation = 'serializable';
   ```
2. Restart the example app (`pnpm --filter @fragno-example/wf-example dev`).
3. Run the concurrency script:
   ```bash
   node packages/fragment-workflows/workflows-smoke-artifacts/load-concurrency.js
   ```

**Expected:**

- Requests should succeed or retry on serialization failures (no 500s).

**Actual:**

- `POST /approval-workflow/instances` returns 500s under concurrent load. Script output
  (2026-02-02):
  ```
  Creating 30 instances...
  Create failures: 10
  Error: POST /approval-workflow/instances -> 500: {"error":"Internal server error","code":"INTERNAL_SERVER_ERROR"}
  ```
- Server log shows serialization errors:
  ```
  Error in handler error: could not serialize access due to concurrent update
  code: '40001'
  routine: 'ExecUpdate'
  ```

**Notes:**

- After switching back to `read committed` and restarting, the same script completed without errors.

**Evidence (2026-02-02, retention/GC current run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5ib6f4` (`demo-data-workflow`, complete).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5ib6f4';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5ib6f4 | complete | (null) | 2026-02-02 19:32:05.408
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 29
  ```

**Evidence (2026-02-02, retention/GC latest run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5icpmx` (`demo-data-workflow`, complete).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5icpmx';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5icpmx | complete | (null) | 2026-02-02 19:33:16.356
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 29
  ```

**Evidence (2026-02-02, retention/GC current run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5idqda` (`demo-data-workflow`, errored).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5idqda';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5idqda | errored | (null) | 2026-02-02 19:34:05.868
  ```
- GC tasks still absent:
  ```sql
  SELECT
    kind,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind
  ORDER BY
    kind;
  ```
  Result:
  ```
   wake | 29
  ```

**Evidence (2026-02-02, retention/GC current run):**

- Script: `node packages/fragment-workflows/workflows-smoke-artifacts/retention-gc-check.js`
- Instance created: `retention_ml5if3fm` (`demo-data-workflow`, errored).
- `retentionUntil` remains `NULL` after completion:
  ```sql
  SELECT
    "workflowName",
    "instanceId",
    status,
    "retentionUntil",
    "completedAt"
  FROM
    "workflow_instance_workflows"
  WHERE
    "instanceId" = 'retention_ml5if3fm';
  ```
  Result:
  ```
   demo-data-workflow | retention_ml5if3fm | errored | (null) | 2026-02-02 19:35:09.461
  ```
- GC tasks still absent (only `wake` tasks observed):
  ```sql
  SELECT
    kind,
    status,
    count(*)
  FROM
    "workflow_task_workflows"
  GROUP BY
    kind,
    status
  ORDER BY
    kind,
    status;
  ```
  Result:
  ```
   wake | pending | 29
  ```
