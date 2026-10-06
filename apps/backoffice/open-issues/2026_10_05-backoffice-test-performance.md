# Backoffice test performance and usefulness audit

Status: open — baseline retained; Codemode test environment split implemented October 6, 2026.

Created: October 5, 2026

Revision audited: `1be70ea51`

All source paths below are relative to `apps/backoffice`, unless explicitly prefixed with
`packages/`.

## Summary

- **Both complete runs passed: 316 files, 1,892 tests passed, 1 skipped.**
- Complete-suite Vitest wall time was **60.63s**, then **103.09s**. These are shared-workstation
  observations, not a controlled performance benchmark.
- The Node-only run passed **302 files / 1,807 tests**, with the same one skipped test, in
  **34.12s**. It does not replace the Cloudflare suite.
- **79 cases took at least 250ms in the baseline; 11 took at least one second.**
- Automation/Marketplace/Telegram and Codemode/Pi account for approximately **69% of summed baseline
  case execution time**. Most of their slow scenarios protect important behavior; deleting them
  would be the wrong first optimization.
- The biggest infrastructure problem is **Cloudflare compiler setup and test-module imports**, not
  assertion execution. Several millisecond-scale tests unnecessarily pay seconds of setup.
- A controlled temporary-copy experiment reduced the ordinary-response shutdown case from **1,011ms
  to 34ms** by disabling the test client's HTTP keep-alive. This also exposes an assertion gap: the
  original case can pass after the force-close deadline, rather than proving prompt graceful
  shutdown.
- The easiest fixture improvement is to stop performing **501+ complete HTTP uploads** just to
  arrange metadata-pagination tests.
- The clearest outright removal candidates are **two source-string/CSS tests**, not the expensive
  recovery, authorization, or concurrency scenarios. Removing them saves maintenance more than
  runtime.

### Recommended order

1. Resolve the listener shutdown/keep-alive issue and strengthen the graceful-shutdown assertion.
2. Move package-owned pure Codemode tests out of Backoffice's Cloudflare pool; consolidate the small
   Pi schema tests into an existing Pi suite.
3. Seed pagination fixtures through real SQLite using the canonical Upload schema instead of
   hundreds of multipart uploads.
4. Consolidate compatible Telegram negative cases into one scenario, preserving every input and
   assertion.
5. Reduce repeated Marketplace publication/installation setup in scenarios where installation is
   only a prerequisite.
6. Remove brittle cosmetic source-string tests; move source-policy checks to lint.
7. Profile the remaining Cloudflare compiler/import graph before changing pool isolation or
   concurrency.

## Implementation follow-up — October 6, 2026

The first Codemode environment changes are implemented; the measurements and CSV files below remain
an October 5 baseline, not measurements of the new layout.

- Moved all six `runtime-api.cloudflare.test.ts` helper cases to
  `packages/codemode/src/runtime-api.test.ts`. They run under Node without a compiler, Worker, or
  bridge. The provider case now records concrete tool inputs rather than using a function mock.
- Normal Backoffice and Codemode package tests exclude bridge lifecycle files before collection.
  Explicit `test:bridge` tasks retain the Node production configuration, WebSocket checkpoint/event
  scenarios, interrupted-activation retry scenario, and Codemode package bridge lifecycle tests. No
  bridge transport guarantees were deleted or represented as covered by direct Cloudflare RPC.
- Strengthened the existing direct Worker workflow cases: nested checkpoint identity, exactly one
  committed emission across runner restarts, Date-preserving event consumption, `onConsume`
  emissions, and durable sleep/resume after restart. These use the existing Cloudflare pool,
  in-process compiler, and local Worker Loader, not an HTTP/WebSocket bridge.
- Default package tests and the direct Worker workflow suite were verified without executing the
  opt-in bridge suite. Bridge discovery and Turbo dependencies were checked separately.

Validation on October 6:

| Check                                       | Result                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| Backoffice default Node + Cloudflare suites | 313 files passed; 1,882 cases passed, 1 skipped; 76.94s Vitest wall                     |
| Codemode default package suite              | 9 files / 30 cases passed                                                               |
| Focused direct Worker workflow suite        | 14 cases passed                                                                         |
| Backoffice and Codemode type checks         | Passed                                                                                  |
| Opt-in bridge discovery                     | Both Backoffice scenario files and the Codemode lifecycle file discovered; not executed |

Backoffice's default count is ten cases lower than the baseline: six helpers moved to Codemode and
four Node transport cases remain in the opt-in bridge task. The 76.94s run is not an isolated
before/after speed benchmark: suite selection and concurrency changed, and type checks ran alongside
the tests.

Run bridge-specific coverage explicitly when changing that transport boundary:

```sh
pnpm exec turbo run test:bridge --filter=@fragno-apps/backoffice-rr --filter=@fragno-dev/codemode --output-logs=errors-only
```

The package-owned disposal test and small Pi schema test are still follow-up opportunities. The
pagination, listener, and Telegram fixture optimizations have not been implemented.

## Measurement method and caveats

Environment: macOS/arm64, 12 logical CPUs, 48 GiB RAM, Node `v26.10.0`, PNPM `11.1.3`, Vitest
`4.1.11`.

The working tree was clean when the audit started. The initial test attempt encountered missing
workspace build outputs: **81 files failed collection**, while 235 files and 1,418 cases passed.
That attempt is **excluded** from the performance rankings. The first PNPM invocation also refreshed
the local dependency installation; dependency preparation is not counted as test execution.

Dependency outputs were restored with:

```sh
pnpm exec turbo run build --filter='@fragno-apps/backoffice-rr^...' --output-logs=errors-only
```

This completed successfully with 23 cached build tasks. Then the package's actual two-project
configuration was exercised directly, bypassing Turbo's test-result cache:

```sh
cd apps/backoffice
pnpm exec vitest run --reporter=default --reporter=json --outputFile.json=/tmp/backoffice-baseline.json
pnpm exec vitest run --project=node --reporter=default --reporter=json --outputFile.json=/tmp/backoffice-node.json
```

A second complete run used the same configuration plus a temporary reporter collecting
`testModule.diagnostic()`: tests/hooks, setup-file imports, test-module imports, environment setup,
and harness preparation. Coverage remained disabled, as configured in `vitest.config.ts`. No retries
or test filtering were added to the complete runs.

| Run                                  | Files | Passed cases | Skipped | Vitest wall | Process wall, including CLI/shutdown |
| ------------------------------------ | ----: | -----------: | ------: | ----------: | -----------------------------------: |
| Complete baseline                    |   316 |        1,892 |       1 |      60.63s |                               61.27s |
| Complete repeat + module diagnostics |   316 |        1,892 |       1 |     103.09s |                              105.08s |
| Node-only                            |   302 |        1,807 |       1 |      34.12s |                               34.80s |

Unrelated builds/lint processes in another worktree were observed during the repeat. Scheduling and
contention affect these results: the Node-only run had **more summed test execution time** than the
complete baseline despite finishing sooner. Do not interpret the differences as a code regression or
as a guaranteed speed-up from excluding Cloudflare.

**Timing definitions:**

- Rankings use the **sum of individual case durations**, called _body time_ below. Vitest's case
  duration can include case-level lifecycle work; it is not CPU-only time.
- `repeat_tests_and_hooks_ms` is the module diagnostic including suite hooks; it can exceed summed
  case durations, e.g. server/database startup and cleanup.
- `repeat_setup_ms` measures setup-file import/execution. `repeat_import_ms` measures test-module
  collection/import, including its dependency graph.
- Per-module setup/import durations can overlap and include waiting for shared transforms. **Their
  sums are not unique CPU work and cannot be subtracted from wall time.**
- The baseline is the ranking reference. The repeat makes variation visible; it is not an isolated
  before/after comparison.
- “Slow” means a baseline case >=250ms or a suite with >=1s summed baseline case time. Additional
  near-slow suites and infrastructure-heavy files are included for triage.

### Retained evidence

- `2026_10_05-backoffice-test-performance-files.csv`: all **316 files**, category, case count, body
  times for all three runs, repeat module diagnostics, and reviewed suite usefulness scores.
- `2026_10_05-backoffice-test-performance-cases.csv`: all **1,893 cases**, exact expanded names,
  status, timings, category, and the containing suite's score.
- Raw JSON/logs and temporary experiment copies are in `/tmp/backoffice-test-audit-2026-10-05/` on
  the audit machine. The CSV inventories retain the important measurements without absolute
  workstation paths or test logs.

## Usefulness scoring

Scores are qualitative regression-value judgments, **not coverage percentages or proof of
redundancy**:

| Score | Meaning                                                                                                                                                      | Default action                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 5/5   | Protects authorization, isolation, durable recovery/replay, idempotency, data integrity, or another critical production boundary with substantive scenarios. | Keep; improve fixtures/harness.                                           |
| 4/5   | Useful observable contract or integration behavior; may have expensive arrangement, a narrow assertion gap, or overlap worth consolidating.                  | Keep behavior; simplify execution.                                        |
| 3/5   | Meaningful but narrow contract/helper coverage or mixed-value suite; weaker evidence than a production-path scenario.                                        | Consolidate or replace when stronger coverage exists.                     |
| 2/5   | Mostly implementation wiring, source-policy checks, or literal structure checks; weak evidence of user-visible correctness.                                  | Move to lint/package owner or remove after preserving the real invariant. |
| 1/5   | Cosmetic source-text checks that do not exercise the behavior they claim to protect.                                                                         | Remove; use actual UI/scenario validation where needed.                   |

**48 suites were scored for triage**, including the slow suites and noteworthy overhead/removal
candidates. Other fast suites are explicitly `not-reviewed` in the inventories. A suite score of 5
means the suite contains important coverage, not that every case deserves 5. The case CSV's
`suite_usefulness_1_to_5` is deliberately a suite-level score; specific case overrides are
identified below.

## Categories

These are mutually exclusive subject-area buckets for the timing inventory; an Auth scenario located
in the Automation scenario directory is counted with Automation. Counts include the skipped case.
Times are baseline summed case time, not wall time.

| Category                                      | Files | Cases | Body time | Cases >=250ms | Value and direction                                                                                                  |
| --------------------------------------------- | ----: | ----: | --------: | ------------: | -------------------------------------------------------------------------------------------------------------------- |
| Automation / Marketplace / Telegram scenarios |    44 |   312 |    32.06s |            48 | Predominantly 5/5; reduce repeated publication, installation, and draining.                                          |
| Codemode / Pi execution and durability        |    17 |   209 |    17.39s |            15 | Predominantly 5/5; keep replay/security boundaries, eliminate unnecessary pool overhead.                             |
| Runtime tools / integrations / utilities      |    93 |   420 |     6.41s |             7 | Mixed; prefer real boundary scenarios over mock-forwarding tests, but do not blanket-delete cheap contract coverage. |
| Auth / identity / OTP                         |    14 |   103 |     4.12s |             2 | 5/5 for admission/authority/token flows; use fixtures only when authentication itself is not under test.             |
| File storage / metadata / pagination          |    11 |    65 |     4.09s |             2 | 4–5/5; high-confidence fixture-cost target.                                                                          |
| Runtime / SQLite / transport / observability  |    41 |   217 |     3.69s |             3 | 4–5/5; preserve real sockets, SQLite restart, and concurrency behavior.                                              |
| UI / route loaders / presentation             |    95 |   561 |     3.52s |             1 | Mostly cheap; source-string checks are lower-value than rendering/interactions.                                      |
| Release tooling                               |     1 |     6 |     0.82s |             1 | 4/5; real child-process orchestration is useful and not a primary bottleneck.                                        |

## Slow and near-slow suites

Body times exclude module-only startup/cleanup. All cases passed unless noted in the overall run
summary.

| File                                                                   | Cases | Baseline body | Repeat body | Suite usefulness |
| ---------------------------------------------------------------------- | ----: | ------------: | ----------: | ---------------: |
| `app/fragno/automation/scenario-marketplace.test.ts`                   |    35 |        10.37s |       8.68s |              5/5 |
| `app/fragno/automation/scenario-starter-router.test.ts`                |    23 |         8.12s |       7.81s |              5/5 |
| `app/fragno/codemode/workflow-execute.cloudflare.test.ts`              |    14 |         7.18s |      15.46s |              5/5 |
| `app/fragno/automation/starter-otp-linking.test.ts`                    |     6 |         3.80s |       4.47s |              5/5 |
| `app/fragno/codemode/run-backoffice-codemode.cloudflare.test.ts`       |    23 |         2.40s |       5.53s |              5/5 |
| `workers/pi-manager.do.scenario.test.ts`                               |     7 |         2.27s |       2.52s |              5/5 |
| `app/routes/backoffice/marketplace/artifact-files.server.test.ts`      |     6 |         2.00s |       1.71s |              4/5 |
| `app/fragno/codemode/workflow-execute.node.scenario.test.ts`           |     3 |         2.00s |       2.07s |              5/5 |
| `app/file-collection/create-upload-file-collection.test.ts`            |    15 |         1.92s |       1.78s |              5/5 |
| `app/fragno/automation/scenario-auth-email-verification.test.ts`       |     6 |         1.72s |       2.09s |              5/5 |
| `app/fragno/pi/exec-code-mode.cloudflare.test.ts`                      |    10 |         1.32s |       1.24s |              5/5 |
| `workers/auth.do.test.ts`                                              |    20 |         1.30s |       1.91s |              5/5 |
| `workers/automations.test.ts`                                          |    22 |         1.27s |       2.22s |              5/5 |
| `workers/auth.do.oauth-device.test.ts`                                 |     9 |         1.20s |       1.21s |              5/5 |
| `workers/pi.do.backoffice.scenario.test.ts`                            |    11 |         1.19s |       3.40s |              5/5 |
| `app/fragno/automation/scenario-system-automations.test.ts`            |     8 |         1.06s |       1.89s |              5/5 |
| `scripts/node-server/node-server-listeners.scenario.test.ts`           |     2 |         1.04s |       1.04s |              4/5 |
| `app/fragno/automation/internal-ingest-event.test.ts`                  |     2 |         0.97s |       3.02s |              5/5 |
| `app/fragno/runtime-tools/families/project-connector.scenario.test.ts` |     5 |         0.94s |       2.37s |              5/5 |
| `app/routes/api/project-connector.scenario.test.ts`                    |     3 |         0.87s |       1.94s |              5/5 |
| `workers/pi.do.cloudflare.test.ts`                                     |     5 |         0.86s |       0.92s |              5/5 |
| `scripts/run-worker-release.test.ts`                                   |     6 |         0.82s |       1.80s |              4/5 |
| `app/fragno/automation/engine/codemode.cloudflare.test.ts`             |     9 |         0.76s |       1.91s |              5/5 |
| `app/fragno/automation/scenario-codemode.test.ts`                      |    13 |         0.74s |       2.08s |              5/5 |
| `app/fragno/runtime-tools/families/internal.scenario.test.ts`          |     3 |         0.69s |       1.62s |              5/5 |
| `workers/auth.do.backoffice-token.test.ts`                             |     5 |         0.63s |       0.75s |              5/5 |
| `app/fragno/runtime-tools/state-shell-file-system.scenario.test.ts`    |     4 |         0.61s |       1.00s |              5/5 |
| `app/backoffice-runtime/node/sqlite-runtime.scenario.test.ts`          |    13 |         0.53s |       1.39s |              5/5 |
| `app/fragno/automation/scenario-workflow-ownership.test.ts`            |     3 |         0.50s |       0.78s |              5/5 |
| `app/fragno/automation/scenario-auth-sign-up-invitation.test.ts`       |     3 |         0.45s |       0.74s |              5/5 |

### Individual cases >=1 second in the baseline

Names are the case titles within the indicated files; full names are retained in the case inventory.

| File / case                                                                                                                    | Baseline | Repeat | Case usefulness | Decision                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------ | -------: | -----: | --------------: | ------------------------------------------------------------------------------- |
| `artifact-files.server.test.ts`: rejects artifact trees larger than one Upload page                                            |    1.84s |  1.53s |             4/5 | Keep overflow/error propagation; replace mass-upload arrangement.               |
| `create-upload-file-collection.test.ts`: retrieves a complete Upload tree across metadata pages                                |    1.79s |  1.64s |             5/5 | Keep real cursor traversal and one-page limit; replace mass-upload arrangement. |
| `workflow-execute.node.scenario.test.ts`: interruption preserves host retry scheduling without falsely committing tool effects |    1.57s |  1.58s |             5/5 | Keep; two real 750ms interruptions dominate.                                    |
| `workflow-execute.cloudflare.test.ts`: runBackofficeCodemodeWorkflow preserves step suspension for wrapper callers             |    1.51s |  2.60s |             5/5 | Keep public-wrapper suspension behavior.                                        |
| Same file: remote sleep suspends until the wake delay has elapsed                                                              |    1.31s |  1.84s |             5/5 | Keep; logical sleep is already clock-controlled.                                |
| Same file: restores workflow progress after the dynamic worker environment is discarded                                        |    1.24s |  3.81s |             5/5 | Keep cold-worker replay; not interchangeable with ordinary resume.              |
| `scenario-marketplace.test.ts`: force-publishes with fresh workflow IDs and overwrites artifact files                          |    1.19s |  0.63s |             5/5 | Keep forced replacement/idempotency behavior.                                   |
| `workflow-execute.cloudflare.test.ts`: exposes previous step emissions as an async remote tx method                            |    1.12s |  2.33s |             5/5 | Keep durable retry/emission semantics.                                          |
| `pi-manager.do.scenario.test.ts`: a cold local agent alarm resumes unfinished SQLite work without duplicating input            |    1.11s |  1.23s |             5/5 | Keep restart/no-duplicate-input scenario.                                       |
| `workflow-execute.cloudflare.test.ts`: suspends and resumes a codemode workflow through waitForEvent                           |    1.07s |  2.67s |             5/5 | Keep real event-consumption/replay path.                                        |
| `node-server-listeners.scenario.test.ts`: Node listener shutdown drains an ordinary response before closing                    |    1.01s |  1.01s |             4/5 | Keep and strengthen; confirmed avoidable keep-alive/deadline cost.              |

## Category: infrastructure-heavy tests with cheap bodies

The repeat diagnostic is particularly revealing here. These are **setup/import measurements**, not
case slowness.

| File                                                                | Cases | Repeat tests + hooks | Repeat setup | Repeat import | Usefulness / action                                                                         |
| ------------------------------------------------------------------- | ----: | -------------------: | -----------: | ------------: | ------------------------------------------------------------------------------------------- |
| `app/fragno/codemode/runtime-api.cloudflare.test.ts`                |     6 |               0.007s |       4.525s |        0.080s | 4/5; move pure package behavior to `packages/codemode`.                                     |
| `app/fragno/codemode/codemode-executor.cloudflare.test.ts`          |     1 |               0.002s |       9.038s |        0.042s | 4/5; mock disposal regression belongs with its package, not compiler integration.           |
| `app/fragno/pi/typebox-failure.cloudflare.test.ts`                  |     2 |               0.003s |      11.531s |       10.987s | 4/5; consolidate into an existing Pi suite or establish a genuinely narrow schema boundary. |
| `workers/lib/pi-session-store.cloudflare.test.ts`                   |     2 |               0.022s |      18.209s |       34.409s | 5/5; retain actual Worker/SQLite boundary, narrow harness dependencies.                     |
| `workers/lib/backoffice-fragment-durable-object.cloudflare.test.ts` |     3 |               0.082s |      18.205s |       34.415s | 5/5; retain Durable Object boundary, narrow harness dependencies.                           |
| `workers/workflows-runner.cloudflare.test.ts`                       |     1 |               0.066s |      18.792s |       33.841s | 5/5; real wrapped SQLite conflict/retry is valuable.                                        |
| `app/fragno/automation/project-event-routing.cloudflare.test.ts`    |     3 |               0.593s |      18.181s |       54.931s | 5/5; retain project/org routing isolation, inspect imports.                                 |

Across the 14 Cloudflare files, repeat setup totals **225.93s**, collection/import totals
**347.35s**, and tests/hooks total **26.47s**. Again, these overlap: this is evidence of where to
profile, not a promise of hundreds of wall-clock seconds saved.

`workers/vitest-compiler-setup.ts` imports `buildWorkerProject` and `typeCheckProject`
unconditionally for every Cloudflare test file, even the pure string/provider and fake-loader tests.
`vitest.cloudflare.config.ts` already uses a test-only Wrangler config; don't mistake this for an
entirely unoptimized production config. The remaining compiler setup and the broad dependencies
reachable from `workers/vitest-env.ts` are the next boundaries to examine.

## Low-hanging speed improvements

### 1. Fix/clarify graceful shutdown before merely shortening its timeout

**Files:** `scripts/node-server/node-server-listeners.scenario.test.ts`,
`scripts/node-server/node-server-listeners.ts`.

The ordinary response test uses `http.get()` with the default client agent and calls
`stopNodeBackofficeListeners(listeners, 1_000)`. It verifies a 25ms blocked period and eventual
successful response, but does not establish that shutdown completes promptly after the response
rather than at the deadline.

A temporary copy ran against the **unchanged production listener implementation**, changing only the
test client's requests to `{ agent: false }`:

| Variant              | Ordinary response | Force-close stream | Result      |
| -------------------- | ----------------: | -----------------: | ----------- |
| Original requests    |           1,011ms |               34ms | Both passed |
| No client keep-alive |              34ms |               29ms | Both passed |

The first experiment also reproduced this at 1,008ms versus 35ms. This strongly implicates the
pooled keep-alive/deadline path, not application work.

**Recommendation:** use a no-keep-alive client for the bounded ordinary-response scenario **only if
that is its intended scope**. Preserve coverage for pooled clients when correcting the listener's
shutdown behavior, and assert timely graceful completion after releasing the handler. If the
promised drain behavior includes keep-alive clients, fix the production idle-connection lifecycle
rather than simply bypassing it in tests. Keep the independent active-stream deadline scenario.

**Measured opportunity:** approximately **0.98s per execution of this case**, not a guaranteed 0.98s
off the parallel suite wall time. Effort: small investigation/test strengthening; a production fix
may be needed.

### 2. Stop paying for the Cloudflare compiler in pure package tests

**Files:** `app/fragno/codemode/runtime-api.cloudflare.test.ts`,
`app/fragno/codemode/codemode-executor.cloudflare.test.ts`.

The first file tests `normalizeCode` and `resolveProvider` from `@fragno-dev/codemode/runtime-api`.
It does not exercise a Worker, compiler, Backoffice route, or database. A temporary Node copy,
importing the same built `runtime-api.js`, passed **all six cases in approximately 2ms**. Only the
import path changed to resolve the dependency from `/tmp`.

The second file supplies a fake loader, fake entrypoint, and disposable promise; it does not use the
configured WorkerLoader or compiler. It does protect a disposal regression, so **move rather than
delete** its behavior. Its implementation imports the Cloudflare dispatcher module, so relocating it
may require the package's existing runtime adapter/test seam; only the runtime-api relocation was
experimentally verified here.

**Recommendation:** co-locate these with `packages/codemode/src/runtime-api.ts` and
`packages/codemode/src/worker/codemode-executor.ts`, using the lightest appropriate package
environment. Do not add more mock-only unit files to Backoffice. Consolidate
`typebox-failure.cloudflare.test.ts` into an existing Pi integration suite if a new standalone
schema boundary has no independent production use.

The three files together execute nine cases in **12ms** in the repeat but incur **25.09s of summed
setup**, plus imports. Their removal from separate Cloudflare files is promising; wall-time savings
require a measured rerun and are **not** equal to that aggregate.

### 3. Arrange metadata pagination with real database fixtures, not full uploads

**Cases:**

- `app/file-collection/create-upload-file-collection.test.ts`: “retrieves a complete Upload tree
  across metadata pages”.
- `app/routes/backoffice/marketplace/artifact-files.server.test.ts`: “rejects artifact trees larger
  than one Upload page”.

The first performs **501 sequential multipart HTTP uploads**; the second uploads **501 additional
files plus seven baseline artifact files**. This runs storage/upload mutation behavior hundreds of
times before asserting metadata listing, cursor handling, or an overflow error.

**Recommendation:** introduce a scenario fixture for ready Upload metadata, validated at the fixture
boundary and written using the canonical Upload schema into real SQLite. Arrange the 501-row
threshold efficiently, then exercise the same real listing route/file collection. These two cases do
not read the arranged content blobs. Existing small upload/stream/search cases must continue to use
real upload operations and durable-hook draining.

`listUploadFiles()` currently requests a fixed `pageSize: "500"`. Do **not** add a production
page-size/test-only switch merely to create a three-row test, replace the listing with a mock, or
weaken the actual 500/501 boundary. Direct fixture setup should maintain valid schema state, not
bypass the behavior being asserted.

**Measured cost being targeted:** **3.63s baseline / 3.17s repeat** for the two cases together; the
Node-only run amplified them to **7.04s** under different scheduling/load. Savings from fixture
seeding are not yet benchmarked. Effort: small/medium.

### 4. Consolidate Telegram negative paths while retaining all four variants

**File:** `app/fragno/automation/scenario-starter-router.test.ts`.

| Case                                                                   | Baseline |           Case usefulness |
| ---------------------------------------------------------------------- | -------: | ------------------------: |
| Telegram /pi skips an unlinked chat                                    |    412ms |  5/5 — admission boundary |
| Telegram text skips an unlinked chat                                   |    364ms | 5/5 — distinct input path |
| Telegram unrelated slash commands do not create starter workflows      |    558ms |       4/5 — routing guard |
| raw Telegram webhooks without messages do not create starter workflows |    444ms |        4/5 — webhook edge |

These four cases spend **1.78s** collectively, each arranging organization/Telegram state and
installing the same Marketplace channel.

**Recommendation:** one scenario can install once, deliver each input with a unique event/update ID,
and assert no unintended messages, Pi calls, or starter workflow instances **after every input**.
Preserve the raw-webhook boundary as a separate step. This removes duplicate arrangement, not
distinct coverage. Do not share a mutable runtime across independent tests or merge cases whose
identity/configuration mutations would contaminate later assertions.

Effort: small. Expected fixture savings are a hypothesis until timed; do not delete the
unlinked-chat variants as “duplicates”.

### 5. Stop replaying unrelated Marketplace preparation in router/linking scenarios

**Files:** `app/fragno/automation/scenario.ts`, `scenario-starter-router.test.ts`,
`starter-otp-linking.test.ts`.

`when.marketplace.install` currently requests **all bundled static publications**, drains, requests
the desired ingestion, drains again, verifies installation, and mirrors installed workspace files.
The scenario runner also drains after steps by default. The helper is a real installation flow,
which is correct when installation itself is under test, but unnecessarily broad when it only
arranges an installed Telegram channel.

**Recommendation:** add a clearly named `given` fixture for the installed-channel prerequisite using
a fresh concrete runtime/database state per scenario. Reuse immutable prepared content or a safely
reset database snapshot where appropriate, not mutable runtime objects. Keep representative
publication/installation scenarios running the entire flow in `scenario-marketplace.test.ts` and the
internal maintenance scenario. First instrument step/drain timings to distinguish publication work
from genuinely redundant no-op drains.

**Impact envelope:** the router and OTP suites account for **11.92s baseline body time**; only their
fixture portion is avoidable. This is a larger opportunity than deleting helper assertions but is
less immediately proven than the listener experiment. Effort: medium.

### 6. Replace incidental real-time waits with explicit lifecycle barriers

**File:** `app/fragno/codemode/workflow-execute.node.scenario.test.ts`.

The interruption case configures a **750ms execution timeout** and performs two interrupted
attempts, explaining most of its stable ~1.58s cost. It asserts persistent effects and final errored
status, so this is **5/5 coverage**, not a deletion candidate.

Prefer an explicit “guest has written its effect and reached the blocked operation” barrier followed
by interruption, while retaining an actual timeout-path scenario at the package boundary. Do not
just reduce 750ms to a fragile small timeout: compilation/WebSocket startup can race the intended
host mutation. Logical workflow time is already controlled with `when.time.advance`/harness clocks.

Effort: medium. Not counted as a confirmed low-effort saving.

### 7. Secondary cleanup, not first-line optimization

- `scripts/run-worker-release.test.ts` launches actual Node release orchestration and fake
  executable children. Its six cases cost **0.82s baseline / 1.80s repeat**. Keep
  bootstrap/upload/deploy distinctions and invalid version-ID rejection; replacing this with mocked
  `spawn` would lose the boundary it tests. Reusing immutable executable fixtures may help slightly,
  but this is not the main bottleneck.
- Several timeout races leave their losing timeout active, e.g. the listener stream watchdog and
  `app/sandbox/cloudflare-sandbox-bridge-provider.test.ts`. Clear those timers in `finally`. This
  improves cleanup discipline; a losing one-second watchdog does **not** mean the passing case
  necessarily waits one second. No wall-time saving is claimed here.
- The cold Pi recovery case deliberately uses a slow faux provider. A “provider started” barrier
  with explicit cancellation could reduce incidental pacing, but preserve persisted unfinished work,
  full runtime restart, and exactly one durable input. Do not replace it with a mocked alarm.

## Low-hanging removal / relocation candidates

These are judged separately from the slow-suite rankings. **No expensive scenario was established to
be safely redundant.**

| File / exact case                                                                                                                                             |                        Value | Proposed action                                                                                                                                                                                       | Baseline execution cost / trade-off                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `app/routes/backoffice/sessions/session-detail/workspace-boundary.test.ts`: keeps the session workspace within a fixed viewport with independent scroll panes |                          1/5 | Remove the literal CSS/source-string test. Retain actual workspace interaction coverage; if viewport behavior needs regression coverage, verify rendered behavior in an appropriate browser scenario. | 0.62ms; maintenance win, essentially no body-time win.                                   |
| Same file: defines a replayable drawer entrance and desktop split transition                                                                                  |                          1/5 | Remove literal stylesheet-string assertions. Keyframe names/text do not establish entrance replay, desktop behavior, or reduced-motion behavior.                                                      | 1.99ms; maintenance win, not a substantial speed-up.                                     |
| Same file: reuses the automation workflow graph without Cadence or XYFlow imports                                                                             |                          2/5 | Move an intentional import-boundary policy to lint before deleting the test.                                                                                                                          | 0.95ms; the architectural rule has value, the string-scanning test is the wrong layer.   |
| `app/fragno/runtime-tools/async-execute.test.ts`: await expression-bodied async execute implementations                                                       |                          2/5 | Replace regex source scanning with an AST-based lint rule expressing the actual await/error-handling policy, then remove this test file.                                                              | 3.44ms; does not exercise runtime await/error propagation and misses alternative syntax. |
| `app/fragno/automation/automations.test.ts`: returns the instrumented durable hooks dispatcher when initialization succeeds                                   | 2/5 for this case; 3/5 suite | Candidate to consolidate into a real dispatcher/hook scenario verifying execution/instrumentation. Delete only once that wiring invariant is covered. Preserve fail-fast initialization behavior.     | 1.90ms; not a proven duplicate or meaningful runtime saving.                             |
| `app/fragno/codemode/runtime-api.cloudflare.test.ts`: six package behavior cases                                                                              |                          4/5 | Remove from Backoffice **by relocating**, not by dropping the grammar/provider contracts.                                                                                                             | Millisecond bodies but seconds of compiler setup; verified to pass in Node.              |
| `app/fragno/codemode/codemode-executor.cloudflare.test.ts`: disposes the raw dynamic worker RPC call result                                                   |                          4/5 | Remove from Backoffice **by relocating** to the package; keep the disposal regression.                                                                                                                | 1ms baseline body; 9.038s repeat setup.                                                  |
| `app/fragno/pi/typebox-failure.cloudflare.test.ts`: two schema cases                                                                                          |                          4/5 | Consolidate into an existing Pi suite; do not drop input validation solely because it is cheap.                                                                                                       | 2ms baseline body; expensive transitive imports/setup.                                   |

The skipped case is `app/fragno/runtime-tools/bash-host.test.ts` → “regression: defense-in-depth
handles assignment command substitutions”. It contributes **no executed test time**. Track/re-enable
or retire it based on the intended shell contract; deleting a skipped test is not a performance
optimization.

## What not to remove or “optimize” away

- Marketplace lost-response replay, interrupted multi-write batches, locally modified-file
  preservation, and permission ceilings. Some of these are under 200ms in the baseline and protect
  substantially more than a superficial happy-path test.
- Pi cold SQLite restart, durable input deduplication, transcript preservation, and view-stream
  behavior. The local and Cloudflare variants exercise different runtime boundaries.
- Auth invitation enforcement, superseded email verification challenges, OAuth/device ownership,
  membership revocation, token rotation, and anonymous Connector returns. Their fixture costs do not
  make them low-value.
- Durable Object wrapped SQLite conflict/retry and Node object coordination. Real concurrency is the
  behavior, not incidental infrastructure to replace with mocks.
- Generated UI catalog validation, literal/dynamic data limits, and workflow
  draft-to-synchronized-event transitions. These protect author/agent-generated input and stale
  workflow state; they are not equivalent to cosmetic markup checks.
- Both public-wrapper suspension and lower-level remote sleep cases without first proving one new
  scenario exercises both entry points and all assertions. Similar names are insufficient evidence
  of duplication.
- Logical “3 seconds” workflow sleeps: they already use controlled clocks, so changing the declared
  sleep length does not eliminate a three-second wall-clock wait.
- Isolation merely to make import costs disappear. Turning off Vitest isolation or sharing global
  mutable scenario state can introduce hidden order dependence.

## Follow-up acceptance checklist

- [ ] Keep a complete-suite pass with the same production-behavior coverage; explain any deliberate
      change in test count.
- [ ] Listener scenario proves prompt ordinary-response drain and separately preserves
      pooled-client/active-stream shutdown guarantees.
- [ ] Pure Codemode tests live with their owning package; no unnecessary Backoffice Cloudflare
      compiler initialization for them.
- [ ] Pagination tests still exercise real SQLite, actual 500/501 metadata boundaries, real cursor
      traversal, and Marketplace overflow propagation.
- [ ] All Telegram negative inputs remain individually asserted inside a scenario; no cross-test
      mutable fixture sharing.
- [ ] Marketplace prerequisite fixtures do not replace publication/installation coverage where that
      behavior is the subject.
- [ ] Every source-policy test removal preserves any intentional policy in lint; cosmetic
      literal-string tests can simply be retired.
- [ ] Rerun the same JSON/module timing measurements without unrelated builds, ideally several
      times, and compare both **wall time** and **case/setup/import distributions**.

During the original audit, only the test-client keep-alive experiment and the pure runtime-api Node
execution were verified as isolated changes. Other savings above are source-backed optimization
candidates, not measured before/after improvements. The October 6 implementation follow-up is
recorded separately above.
