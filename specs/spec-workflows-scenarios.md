# Workflows Scenario DSL — Spec

## 0. Open Questions

None.

## 1. Overview

Provide a TypeScript-first **Scenario DSL** for the workflows fragment that mirrors the Lofi
`defineScenario` pattern. Scenarios define a workflow registry, harness configuration, and a
sequence of steps (create instance, tick, advance time, send event, read/assert). The DSL is used in
Vitest to exercise end-to-end workflow behavior with a deterministic clock and controlled runner
ticks.

This DSL is intentionally **test-only** and built on top of `createWorkflowsTestHarness` so it stays
aligned with the fragment’s public surface area.

## 2. References

- Lofi scenario DSL implementation: `packages/lofi/src/scenario.ts`
- Lofi scenario usage tests: `packages/lofi/src/testing/scenario.test.ts`
- Lofi spec section for scenario DSL: `specs/spec-lofi-submit.md#18` (Scenario DSL)
- Workflows test harness: `packages/fragment-workflows/src/test.ts`
- Workflows harness tests (clock + runner patterns):
  `packages/fragment-workflows/src/test-harness.test.ts`
- Workflows public API types: `packages/fragment-workflows/src/workflow.ts`
- Workflows testing docs: `apps/docs/content/docs/workflows/quickstart.mdx`,
  `apps/docs/content/docs/workflows/fragment.mdx`

## 3. Terminology

- **Scenario**: A declarative test sequence for workflows, expressed as steps.
- **Step**: A single action in a scenario (create, tick, advance time, send event, read, assert).
- **Harness**: The `createWorkflowsTestHarness` instance used to execute steps.
- **Tick**: A single runner invocation using a `WorkflowEnqueuedHookPayload`.
- **Clock**: The test clock exposed by the harness (`WorkflowsTestClock`).

## 4. Goals / Non-goals

### 4.1 Goals

1. Provide a `defineScenario` API for workflows that mirrors Lofi’s ergonomics.
2. Allow deterministic testing of `sleep`, `waitForEvent`, retries, and pause/resume flows.
3. Minimize test boilerplate by defaulting harness setup (adapter, runtime, test builder).
4. Make it easy to capture intermediate values (instance IDs, status, history) via scenario vars.
5. Allow low-level access via custom read/assert steps when needed.

### 4.2 Non-goals

- A production runner or CLI for scenarios.
- A general workflow authoring DSL (this is test-only).
- Model-checker orchestration beyond what the harness already supports.

## 5. Packages / Components

### 5.1 New Scenario Module

Add a new scenario DSL module in `packages/fragment-workflows/src/scenario.ts` and export it as
`@fragno-dev/workflows/scenario`.

The module is test-only and depends on `@fragno-dev/workflows/test` for harness creation.

### 5.2 Exports

- Add `./scenario` to `packages/fragment-workflows/package.json` exports.
- The DSL is exposed only at `@fragno-dev/workflows/scenario` (no re-export from
  `@fragno-dev/workflows/test`).

## 6. User-facing API

### 6.1 Scenario Types

```ts
export type WorkflowScenarioVars = Record<string, unknown>;

type ScenarioInput<T, TRegistry extends WorkflowsRegistry, TVars extends WorkflowScenarioVars> =
  | T
  | ((ctx: WorkflowScenarioContext<TRegistry, TVars>) => T | Promise<T>);

export type WorkflowScenarioHarnessOptions<TRegistry extends WorkflowsRegistry> = Omit<
  WorkflowsTestHarnessOptions<TRegistry>,
  "workflows" | "adapter" | "testBuilder"
> & {
  adapter?: SupportedAdapter;
  testBuilder?: DatabaseFragmentsTestBuilder<{}, undefined>;
};

export type WorkflowScenarioDefinition<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TVars extends WorkflowScenarioVars = WorkflowScenarioVars,
> = {
  name: string;
  workflows: TRegistry;
  harness?: WorkflowScenarioHarnessOptions<TRegistry>;
  steps: WorkflowScenarioStep<TRegistry, TVars>[];
};

export type WorkflowScenarioContext<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TVars extends WorkflowScenarioVars = WorkflowScenarioVars,
> = {
  name: string;
  harness: WorkflowsTestHarness<TRegistry>;
  runtime: WorkflowsTestRuntime;
  clock: WorkflowsTestClock;
  vars: Partial<TVars>;
  utils: WorkflowScenarioUtils<TRegistry>;
  cleanup: () => Promise<void>;
};

export type WorkflowScenarioResult<TVars extends WorkflowScenarioVars = WorkflowScenarioVars> = {
  name: string;
  vars: Partial<TVars>;
  runtime: WorkflowsTestRuntime;
  clock: WorkflowsTestClock;
};

export type WorkflowScenarioInstanceRow = {
  id: bigint;
  instanceId: string;
  workflowName: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  params: unknown;
  output: unknown | null;
  errorName: string | null;
  errorMessage: string | null;
  pauseRequested: boolean;
  runNumber: number;
};

export type WorkflowScenarioStepRow = {
  id: bigint;
  instanceRef: bigint;
  workflowName: string;
  instanceId: string;
  runNumber: number;
  stepKey: string;
  name: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number | null;
  nextRetryAt: Date | null;
  wakeAt: Date | null;
  waitEventType: string | null;
  result: unknown | null;
  errorName: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowScenarioEventRow = {
  id: bigint;
  instanceRef: bigint;
  workflowName: string;
  instanceId: string;
  runNumber: number;
  type: string;
  payload: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

export type WorkflowScenarioUtils<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> = {
  getInstance: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
  ) => Promise<WorkflowScenarioInstanceRow | null>;
  requireInstance: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
  ) => Promise<WorkflowScenarioInstanceRow>;
  getSteps: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: { runNumber?: number; order?: "asc" | "desc" },
  ) => Promise<WorkflowScenarioStepRow[]>;
  getEvents: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: { runNumber?: number; order?: "asc" | "desc" },
  ) => Promise<WorkflowScenarioEventRow[]>;
  buildPayload: (options: {
    workflow: (keyof TRegistry & string) | string;
    instanceId: string;
    reason: WorkflowEnqueuedHookPayload["reason"];
    runNumber?: number;
    timestamp?: Date;
  }) => Promise<WorkflowEnqueuedHookPayload>;
  /**
   * Internal helpers for inspecting durable hooks.
   * These are intentionally semi-hidden; downstream workflows users should not rely on them.
   */
  internal: WorkflowScenarioInternalUtils;
};

export type WorkflowScenarioHookRow = {
  id: bigint;
  namespace: string;
  hookName: string;
  payload: unknown;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
  error: string | null;
  createdAt: Date;
  nonce: string;
};

export type WorkflowScenarioInternalUtils = {
  /**
   * Inspect durable hook rows (fragno_hooks) for debugging.
   * Defaults to the workflows namespace (`workflows`).
   */
  getHooks: (options?: {
    namespace?: string;
    hookName?: string;
    status?: WorkflowScenarioHookRow["status"];
    workflowName?: string;
    instanceId?: string;
  }) => Promise<WorkflowScenarioHookRow[]>;
};
```

Defaults:

- `adapter`: `{ type: "kysely-sqlite" }` (in-memory SQLite)
- `testBuilder`: `buildDatabaseFragmentsTest()`
- `runtime`: `createWorkflowsTestRuntime()`
- `autoTickHooks`: `false` (explicit ticking only)
- `runScenario` auto-cleans up after success and returns a `WorkflowScenarioResult`

### 6.2 Scenario Utilities

Provide helper functions on `ctx.utils` so tests avoid ad-hoc database queries for common cases. All
helpers use the harness database and the indexes defined in
`packages/fragment-workflows/src/schema.ts`.

- `getInstance` uses `idx_workflow_instance_workflowName_instanceId`.
- `getSteps` uses `idx_workflow_step_history_createdAt` and defaults `runNumber` to the current
  instance run when omitted.
- `getEvents` uses `idx_workflow_event_history_createdAt` and defaults `runNumber` to the current
  instance run when omitted.
- `buildPayload` resolves the instance row and produces a `WorkflowEnqueuedHookPayload` using the
  resolved internal instance ref and run number.
- `internal.getHooks` exposes **semi-hidden** access to `fragno_hooks` for verifying durable hook
  scheduling. This is explicitly **not** a public workflows API; it exists to make correctness tests
  easier when debugging runner scheduling.
  - Implementation uses the internal fragment hook service (`getHooksByNamespace`) and then applies
    optional filters (`hookName`, `status`, and payload-based `workflowName`/`instanceId`)
    in-memory.

### 6.3 Scenario Steps

```ts
export type WorkflowScenarioStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> =
  | WorkflowScenarioCreateStep<TRegistry, TVars>
  | WorkflowScenarioCreateBatchStep<TRegistry, TVars>
  | WorkflowScenarioSendEventStep<TRegistry, TVars>
  | WorkflowScenarioTickStep<TRegistry, TVars>
  | WorkflowScenarioRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioStatusStep<TRegistry, TVars>
  | WorkflowScenarioHistoryStep<TRegistry, TVars>
  | WorkflowScenarioAdvanceTimeStep<TRegistry, TVars>
  | WorkflowScenarioSetTimeStep<TRegistry, TVars>
  | WorkflowScenarioReadStep<TRegistry, TVars>
  | WorkflowScenarioAssertStep<TRegistry, TVars>;
```

Step shapes (sketch):

```ts
export type WorkflowScenarioCreateStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "create";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  params?: ScenarioInput<unknown, TRegistry, TVars>;
  id?: ScenarioInput<string, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined; // stores instanceId
};

export type WorkflowScenarioCreateBatchStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "createBatch";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instances: ScenarioInput<Array<{ id: string; params?: unknown }>, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined; // stores array result
};

export type WorkflowScenarioSendEventStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "event";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  event: ScenarioInput<{ type: string; payload?: unknown }, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined; // stores InstanceStatus
};

export type WorkflowScenarioTickStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "tick";
  payload?: ScenarioInput<WorkflowEnqueuedHookPayload, TRegistry, TVars>;
  workflow?: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId?: ScenarioInput<string, TRegistry, TVars>;
  reason?: ScenarioInput<WorkflowEnqueuedHookPayload["reason"], TRegistry, TVars>;
  timestamp?: ScenarioInput<Date, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined; // stores processed count
};

export type WorkflowScenarioRunUntilIdleStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "runUntilIdle";
  payload?: ScenarioInput<WorkflowEnqueuedHookPayload, TRegistry, TVars>;
  workflow?: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId?: ScenarioInput<string, TRegistry, TVars>;
  reason?: ScenarioInput<WorkflowEnqueuedHookPayload["reason"], TRegistry, TVars>;
  timestamp?: ScenarioInput<Date, TRegistry, TVars>;
  maxTicks?: ScenarioInput<number, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined; // stores { processed, ticks }
};

export type WorkflowScenarioStatusStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "status";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined; // stores InstanceStatus
};

export type WorkflowScenarioHistoryStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "history";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  options?: ScenarioInput<
    {
      runNumber?: number;
      pageSize?: number;
      stepsCursor?: string;
      eventsCursor?: string;
      order?: "asc" | "desc";
    },
    TRegistry,
    TVars
  >;
  storeAs?: (keyof TVars & string) | undefined; // stores WorkflowsHistory
};

export type WorkflowScenarioAdvanceTimeStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "advanceTime";
  duration: ScenarioInput<WorkflowDuration, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined; // stores Date
};

export type WorkflowScenarioSetTimeStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "setTime";
  timestamp: ScenarioInput<Date | number, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined; // stores Date
};

export type WorkflowScenarioReadStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "read";
  read: (ctx: WorkflowScenarioContext<TRegistry, TVars>) => unknown | Promise<unknown>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioAssertStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "assert";
  assert: (ctx: WorkflowScenarioContext<TRegistry, TVars>) => void | Promise<void>;
};
```

### 6.3 Helpers

```ts
export function defineScenario<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars
>(scenario: WorkflowScenarioDefinition<TRegistry, TVars>):
  WorkflowScenarioDefinition<TRegistry, TVars>;

export const createScenarioSteps: <
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars
>() => {
  create: (...)
  createBatch: (...)
  event: (...)
  tick: (...)
  runUntilIdle: (...)
  status: (...)
  history: (...)
  advanceTime: (...)
  setTime: (...)
  read: (...)
  assert: (...)
};

export const steps = createScenarioSteps();

export async function runScenario<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars
>(
  scenario: WorkflowScenarioDefinition<TRegistry, TVars>
): Promise<WorkflowScenarioResult<TVars>>;
```

### 6.4 Example

```ts
import { describe, expect, it } from "vitest";
import { defineWorkflow } from "@fragno-dev/workflows";
import { defineScenario, runScenario, steps } from "@fragno-dev/workflows/scenario";

const SleepWorkflow = defineWorkflow({ name: "sleep-workflow" }, async (event, step) => {
  await step.sleep("sleep", "1 hour");
  return { note: event.payload.note };
});

let retryAttempts = 0;
const RetryWorkflow = defineWorkflow({ name: "retry-workflow" }, async (_event, step) => {
  return await step.do(
    "maybe-fail",
    { retries: { limit: 1, delay: "10 minutes", backoff: "constant" } },
    () => {
      retryAttempts += 1;
      if (retryAttempts === 1) {
        throw new Error("RETRY_ME");
      }
      return { ok: true };
    },
  );
});

const ApprovalWorkflow = defineWorkflow({ name: "approval-workflow" }, async (_event, step) => {
  const approval = await step.waitForEvent("await approval", {
    type: "approved",
    timeout: "2 hours",
  });
  return await step.do("finish", () => ({ approval }));
});

const scenario = defineScenario({
  name: "all-features",
  workflows: {
    sleep: SleepWorkflow,
    retry: RetryWorkflow,
    approvals: ApprovalWorkflow,
  },
  harness: {
    adapter: { type: "kysely-sqlite" },
    autoTickHooks: false,
    clockStartAt: 0,
  },
  steps: [
    steps.setTime({ timestamp: 0, storeAs: "startTime" }),
    steps.create({
      workflow: "sleep",
      id: "sleep-1",
      params: { note: "alpha" },
      storeAs: "sleepId",
    }),
    steps.createBatch({
      workflow: "approvals",
      instances: [
        { id: "approval-1", params: { note: "a" } },
        { id: "approval-2", params: { note: "b" } },
      ],
      storeAs: "approvalBatch",
    }),
    steps.create({
      workflow: "retry",
      id: "retry-1",
      storeAs: "retryId",
    }),
    steps.read({
      read: (ctx) => ctx.utils.requireInstance("sleep", "sleep-1"),
      storeAs: "sleepRow",
    }),
    steps.tick({
      payload: (ctx) =>
        ctx.utils.buildPayload({
          workflow: "sleep",
          instanceId: "sleep-1",
          reason: "create",
          timestamp: ctx.clock.now(),
        }),
      storeAs: "sleepTickProcessed",
    }),
    steps.runUntilIdle({
      workflow: "approvals",
      instanceId: "approval-1",
      reason: "create",
      storeAs: "approvalFirstRun",
    }),
    steps.runUntilIdle({
      workflow: "retry",
      instanceId: "retry-1",
      reason: "create",
      maxTicks: 10,
      storeAs: "retryFirstRun",
    }),
    steps.status({
      workflow: "retry",
      instanceId: "retry-1",
      storeAs: "retryStatus",
    }),
    steps.advanceTime({ duration: "10 minutes", storeAs: "afterRetryDelay" }),
    steps.runUntilIdle({
      workflow: "retry",
      instanceId: "retry-1",
      reason: "retry",
      storeAs: "retrySecondRun",
    }),
    steps.runUntilIdle({
      workflow: "sleep",
      instanceId: (ctx) => String(ctx.vars.sleepId),
      reason: "create",
      storeAs: "sleepFirstRun",
    }),
    steps.status({
      workflow: "sleep",
      instanceId: (ctx) => String(ctx.vars.sleepId),
      storeAs: "sleepStatus",
    }),
    steps.advanceTime({ duration: "1 hour", storeAs: "afterSleep" }),
    steps.runUntilIdle({
      workflow: "sleep",
      instanceId: (ctx) => String(ctx.vars.sleepId),
      reason: "wake",
      storeAs: "sleepFinalRun",
    }),
    steps.event({
      workflow: "approvals",
      instanceId: "approval-1",
      event: { type: "approved", payload: { ok: true } },
      storeAs: "approvalStatus",
    }),
    steps.runUntilIdle({
      workflow: "approvals",
      instanceId: "approval-1",
      reason: "event",
      storeAs: "approvalSecondRun",
    }),
    steps.status({
      workflow: "approvals",
      instanceId: "approval-1",
      storeAs: "approvalFinalStatus",
    }),
    steps.history({
      workflow: "sleep",
      instanceId: "sleep-1",
      options: { order: "asc", pageSize: 50 },
      storeAs: "sleepHistory",
    }),
    steps.read({
      read: (ctx) => ctx.utils.getSteps("sleep", "sleep-1"),
      storeAs: "sleepSteps",
    }),
    steps.read({
      read: (ctx) =>
        ctx.utils.internal.getHooks({
          hookName: "onWorkflowEnqueued",
          workflowName: "sleep-workflow",
          instanceId: "sleep-1",
        }),
      storeAs: "hooks",
    }),
    steps.assert((ctx) => {
      expect(ctx.vars.sleepStatus?.status).toBe("waiting");
      expect(ctx.vars.approvalFinalStatus?.status).toBe("complete");
      expect(ctx.vars.sleepHistory?.steps.length).toBeGreaterThan(0);
      expect(ctx.vars.sleepSteps?.length).toBeGreaterThan(0);
      expect(ctx.vars.hooks?.length).toBeGreaterThan(0);
    }),
  ],
});

it("runs a full workflow scenario", async () => {
  const result = await runScenario(scenario);
  expect(result.vars.sleepId).toBe("sleep-1");
});
```

## 7. Execution Model / Lifecycle

1. `runScenario` creates a `WorkflowsTestHarness` with the scenario’s `workflows` and harness
   overrides, falling back to the defaults in §6.1.
2. Scenario steps run sequentially. For any field defined as `ScenarioInput`, values are resolved at
   execution time.
3. `tick` and `runUntilIdle` steps resolve a `WorkflowEnqueuedHookPayload` in one of two ways:
   - If `payload` is provided, use it directly.
   - Otherwise, require `{ workflow, instanceId, reason }`, query `workflow_instance` to find the
     internal instance ref + latest run number, and build the payload. `timestamp` defaults to the
     scenario clock’s `now()`.
4. `advanceTime` and `setTime` use the harness clock.
5. `ctx.utils` provides common DB lookups and payload construction to avoid ad-hoc queries.
6. On any error, the scenario runner calls `context.cleanup()` before rethrowing.
7. On success, the runner calls `context.cleanup()` and returns a `WorkflowScenarioResult` with
   `vars`, `runtime`, and `clock`. On error, it still cleans up before rethrowing.

## 8. Limits & Validation

- Unknown workflow names raise `WORKFLOW_NOT_FOUND` with the workflow name included.
- `tick`/`runUntilIdle` without a payload require both `workflow` and `instanceId`.
- `tick`/`runUntilIdle` fail fast if the instance cannot be found or lacks an internal ID.
- `storeAs` overwrites any existing value in `vars` to keep the DSL simple and explicit.

## 9. Testing

- Add a scenario-focused test file (e.g. `packages/fragment-workflows/src/scenario.test.ts`) that
  covers:
  - sleep + wake flow
  - event wait/resume flow
  - retry scheduling with clock advance
  - history capture
- Convert at least one existing harness test to use the scenario DSL for end-to-end validation.

## 10. Documentation Updates

- Update `apps/docs/content/docs/workflows/quickstart.mdx` and
  `apps/docs/content/docs/workflows/fragment.mdx` to include a short scenario DSL example and link
  to `@fragno-dev/workflows/scenario`.

## 11. Decisions (Locked)

- The scenario DSL is test-only and built on top of `createWorkflowsTestHarness`.
- Scenarios run steps sequentially and resolve inputs at execution time.
- `runScenario` always cleans up on error.
- Export path is `@fragno-dev/workflows/scenario` only.
- Default `autoTickHooks` is `false` (explicit ticking).
- `runScenario` auto-cleans up after success and returns a result (no explicit cleanup required).
- Default adapter is `{ type: "kysely-sqlite" }` (in-memory SQLite).
- `ctx.utils` provides common DB lookups (instance/steps/events), payload building, and semi-hidden
  hook inspection via `ctx.utils.internal.getHooks`.
