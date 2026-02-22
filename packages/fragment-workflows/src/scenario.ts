import { getInternalFragment } from "@fragno-dev/db";
import {
  buildDatabaseFragmentsTest,
  type DatabaseFragmentsTestBuilder,
  type SupportedAdapter,
} from "@fragno-dev/test";
import type { AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import type {
  InstanceStatus,
  WorkflowDuration,
  WorkflowEnqueuedHookPayload,
  WorkflowsRegistry,
} from "./workflow";
import {
  createWorkflowsTestHarness,
  type WorkflowsHistory,
  type WorkflowsTestClock,
  type WorkflowsTestHarness,
  type WorkflowsTestHarnessOptions,
  type WorkflowsTestRuntime,
} from "./test";

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
  state: WorkflowScenarioState<TRegistry>;
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

export type WorkflowScenarioState<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> = {
  getInstance: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
  ) => Promise<WorkflowScenarioInstanceRow | null>;
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
  getStatus: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
  ) => Promise<InstanceStatus>;
  getHistory: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: {
      runNumber?: number;
      pageSize?: number;
      stepsCursor?: string;
      eventsCursor?: string;
      order?: "asc" | "desc";
    },
  ) => Promise<WorkflowsHistory>;
  /**
   * Internal helpers for inspecting durable hooks.
   * These are intentionally semi-hidden; downstream workflows users should not rely on them.
   */
  internal: WorkflowScenarioStateInternalUtils;
};

export type WorkflowScenarioRouteResponse = {
  type: string;
  data?: unknown;
  error?: { message: string; code: string };
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

export type WorkflowScenarioStateInternalUtils = {
  /**
   * Inspect durable hook rows (fragno_hooks) for debugging.
   * Defaults to the workflows namespace ("workflows").
   */
  getHooks: (options?: {
    namespace?: string;
    hookName?: string;
    status?: WorkflowScenarioHookRow["status"];
    workflowName?: string;
    instanceId?: string;
  }) => Promise<WorkflowScenarioHookRow[]>;
};

export type WorkflowScenarioStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> =
  | WorkflowScenarioCreateStep<TRegistry, TVars>
  | WorkflowScenarioInitializeAndRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioCreateBatchStep<TRegistry, TVars>
  | WorkflowScenarioSendEventStep<TRegistry, TVars>
  | WorkflowScenarioEventAndRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioPauseStep<TRegistry, TVars>
  | WorkflowScenarioResumeStep<TRegistry, TVars>
  | WorkflowScenarioResumeAndRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioTerminateStep<TRegistry, TVars>
  | WorkflowScenarioRestartStep<TRegistry, TVars>
  | WorkflowScenarioRunCreateUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioRunResumeUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioRetryAndRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioTickStep<TRegistry, TVars>
  | WorkflowScenarioRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioAdvanceTimeAndRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioReadStep<TRegistry, TVars>
  | WorkflowScenarioAssertStep<TRegistry, TVars>;

export type WorkflowScenarioCreateStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "create";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  params?: ScenarioInput<unknown, TRegistry, TVars>;
  id?: ScenarioInput<string, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioInitializeAndRunUntilIdleStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "initializeAndRunUntilIdle";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  params?: ScenarioInput<unknown, TRegistry, TVars>;
  id?: ScenarioInput<string, TRegistry, TVars>;
  timestamp?: ScenarioInput<Date, TRegistry, TVars>;
  maxTicks?: ScenarioInput<number, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
  runStoreAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioCreateBatchStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "createBatch";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instances: ScenarioInput<Array<{ id: string; params?: unknown }>, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioSendEventStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "event";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  event: ScenarioInput<{ type: string; payload?: unknown }, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioEventAndRunUntilIdleStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "eventAndRunUntilIdle";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  event: ScenarioInput<{ type: string; payload?: unknown }, TRegistry, TVars>;
  timestamp?: ScenarioInput<Date, TRegistry, TVars>;
  maxTicks?: ScenarioInput<number, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
  runStoreAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioPauseStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "pause";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioResumeStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "resume";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioResumeAndRunUntilIdleStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "resumeAndRunUntilIdle";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  timestamp?: ScenarioInput<Date, TRegistry, TVars>;
  maxTicks?: ScenarioInput<number, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
  runStoreAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioTerminateStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "terminate";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioRestartStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "restart";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioRunCreateUntilIdleStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "runCreateUntilIdle";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  timestamp?: ScenarioInput<Date, TRegistry, TVars>;
  maxTicks?: ScenarioInput<number, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioRunResumeUntilIdleStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "runResumeUntilIdle";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  timestamp?: ScenarioInput<Date, TRegistry, TVars>;
  maxTicks?: ScenarioInput<number, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioRetryAndRunUntilIdleStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "retryAndRunUntilIdle";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  timestamp?: ScenarioInput<Date, TRegistry, TVars>;
  maxTicks?: ScenarioInput<number, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
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
  storeAs?: (keyof TVars & string) | undefined;
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
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioAdvanceTimeAndRunUntilIdleStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "advanceTimeAndRunUntilIdle";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  advanceBy?: ScenarioInput<WorkflowDuration, TRegistry, TVars>;
  setTo?: ScenarioInput<Date | number, TRegistry, TVars>;
  maxTicks?: ScenarioInput<number, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
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

export function defineScenario<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
>(
  scenario: WorkflowScenarioDefinition<TRegistry, TVars>,
): WorkflowScenarioDefinition<TRegistry, TVars> {
  return scenario;
}

type StepInput<TStep extends { type: string }> = Omit<TStep, "type">;

export const createScenarioSteps = <
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
>() => ({
  create: (
    input: StepInput<WorkflowScenarioCreateStep<TRegistry, TVars>>,
  ): WorkflowScenarioCreateStep<TRegistry, TVars> => ({
    type: "create",
    ...input,
  }),
  initializeAndRunUntilIdle: (
    input: StepInput<WorkflowScenarioInitializeAndRunUntilIdleStep<TRegistry, TVars>>,
  ): WorkflowScenarioInitializeAndRunUntilIdleStep<TRegistry, TVars> => ({
    type: "initializeAndRunUntilIdle",
    ...input,
  }),
  createBatch: (
    input: StepInput<WorkflowScenarioCreateBatchStep<TRegistry, TVars>>,
  ): WorkflowScenarioCreateBatchStep<TRegistry, TVars> => ({
    type: "createBatch",
    ...input,
  }),
  event: (
    input: StepInput<WorkflowScenarioSendEventStep<TRegistry, TVars>>,
  ): WorkflowScenarioSendEventStep<TRegistry, TVars> => ({
    type: "event",
    ...input,
  }),
  eventAndRunUntilIdle: (
    input: StepInput<WorkflowScenarioEventAndRunUntilIdleStep<TRegistry, TVars>>,
  ): WorkflowScenarioEventAndRunUntilIdleStep<TRegistry, TVars> => ({
    type: "eventAndRunUntilIdle",
    ...input,
  }),
  pause: (
    input: StepInput<WorkflowScenarioPauseStep<TRegistry, TVars>>,
  ): WorkflowScenarioPauseStep<TRegistry, TVars> => ({
    type: "pause",
    ...input,
  }),
  resume: (
    input: StepInput<WorkflowScenarioResumeStep<TRegistry, TVars>>,
  ): WorkflowScenarioResumeStep<TRegistry, TVars> => ({
    type: "resume",
    ...input,
  }),
  resumeAndRunUntilIdle: (
    input: StepInput<WorkflowScenarioResumeAndRunUntilIdleStep<TRegistry, TVars>>,
  ): WorkflowScenarioResumeAndRunUntilIdleStep<TRegistry, TVars> => ({
    type: "resumeAndRunUntilIdle",
    ...input,
  }),
  terminate: (
    input: StepInput<WorkflowScenarioTerminateStep<TRegistry, TVars>>,
  ): WorkflowScenarioTerminateStep<TRegistry, TVars> => ({
    type: "terminate",
    ...input,
  }),
  restart: (
    input: StepInput<WorkflowScenarioRestartStep<TRegistry, TVars>>,
  ): WorkflowScenarioRestartStep<TRegistry, TVars> => ({
    type: "restart",
    ...input,
  }),
  runCreateUntilIdle: (
    input: StepInput<WorkflowScenarioRunCreateUntilIdleStep<TRegistry, TVars>>,
  ): WorkflowScenarioRunCreateUntilIdleStep<TRegistry, TVars> => ({
    type: "runCreateUntilIdle",
    ...input,
  }),
  runResumeUntilIdle: (
    input: StepInput<WorkflowScenarioRunResumeUntilIdleStep<TRegistry, TVars>>,
  ): WorkflowScenarioRunResumeUntilIdleStep<TRegistry, TVars> => ({
    type: "runResumeUntilIdle",
    ...input,
  }),
  retryAndRunUntilIdle: (
    input: StepInput<WorkflowScenarioRetryAndRunUntilIdleStep<TRegistry, TVars>>,
  ): WorkflowScenarioRetryAndRunUntilIdleStep<TRegistry, TVars> => ({
    type: "retryAndRunUntilIdle",
    ...input,
  }),
  tick: (
    input: StepInput<WorkflowScenarioTickStep<TRegistry, TVars>>,
  ): WorkflowScenarioTickStep<TRegistry, TVars> => ({
    type: "tick",
    ...input,
  }),
  runUntilIdle: (
    input: StepInput<WorkflowScenarioRunUntilIdleStep<TRegistry, TVars>>,
  ): WorkflowScenarioRunUntilIdleStep<TRegistry, TVars> => ({
    type: "runUntilIdle",
    ...input,
  }),
  advanceTimeAndRunUntilIdle: (
    input: StepInput<WorkflowScenarioAdvanceTimeAndRunUntilIdleStep<TRegistry, TVars>>,
  ): WorkflowScenarioAdvanceTimeAndRunUntilIdleStep<TRegistry, TVars> => ({
    type: "advanceTimeAndRunUntilIdle",
    ...input,
  }),
  read: (
    input: StepInput<WorkflowScenarioReadStep<TRegistry, TVars>>,
  ): WorkflowScenarioReadStep<TRegistry, TVars> => ({
    type: "read",
    ...input,
  }),
  assert: (
    assert: WorkflowScenarioAssertStep<TRegistry, TVars>["assert"],
  ): WorkflowScenarioAssertStep<TRegistry, TVars> => ({
    type: "assert",
    assert,
  }),
});

export const steps = createScenarioSteps();

const resolveScenarioInput = async <
  T,
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
>(
  input: ScenarioInput<T, TRegistry, TVars>,
  ctx: WorkflowScenarioContext<TRegistry, TVars>,
): Promise<T> => {
  if (typeof input === "function") {
    return await (input as (context: WorkflowScenarioContext<TRegistry, TVars>) => T | Promise<T>)(
      ctx,
    );
  }
  return input;
};

type WorkflowResolver = {
  resolveName: (workflowNameOrKey: string) => string;
  assertName: (workflowName: string) => void;
};

const createWorkflowResolver = <TRegistry extends WorkflowsRegistry>(
  workflows: TRegistry,
): WorkflowResolver => {
  const workflowNames = new Set(Object.values(workflows).map((entry) => entry.name));

  return {
    resolveName: (workflowNameOrKey: string) => {
      const lookup = workflows[workflowNameOrKey];
      if (lookup) {
        return lookup.name;
      }
      if (workflowNames.has(workflowNameOrKey)) {
        return workflowNameOrKey;
      }
      throw new Error(`WORKFLOW_NOT_FOUND: ${workflowNameOrKey}`);
    },
    assertName: (workflowName: string) => {
      if (!workflowNames.has(workflowName)) {
        throw new Error(`WORKFLOW_NOT_FOUND: ${workflowName}`);
      }
    },
  };
};

const resolveInternalId = (value: { internalId?: bigint } | bigint, label: string) => {
  if (typeof value === "bigint") {
    return value;
  }
  const internalId = value.internalId;
  if (internalId === undefined) {
    throw new Error(`Missing internal ID for ${label}`);
  }
  return internalId;
};

const getScenarioInstanceRow = async <TRegistry extends WorkflowsRegistry>(
  harness: WorkflowsTestHarness<TRegistry>,
  workflowName: string,
  instanceId: string,
) => {
  const [instance] = await harness.db.find("workflow_instance", (b) =>
    b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
      eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
    ),
  );
  return instance ?? null;
};

const buildHistoryEntryError = (row: { errorName: string | null; errorMessage: string | null }) => {
  if (!row.errorName && !row.errorMessage) {
    return undefined;
  }
  return {
    name: row.errorName ?? "Error",
    message: row.errorMessage ?? "",
  };
};

const createScenarioState = <TRegistry extends WorkflowsRegistry>(
  harness: WorkflowsTestHarness<TRegistry>,
  resolver: WorkflowResolver,
): WorkflowScenarioState<TRegistry> => {
  const mapInstanceRow = (instance: {
    id: { internalId?: bigint } | bigint;
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
  }): WorkflowScenarioInstanceRow => ({
    id: resolveInternalId(instance.id, "workflow instance"),
    instanceId: instance.instanceId,
    workflowName: instance.workflowName,
    status: instance.status,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    startedAt: instance.startedAt,
    completedAt: instance.completedAt,
    params: instance.params,
    output: instance.output ?? null,
    errorName: instance.errorName ?? null,
    errorMessage: instance.errorMessage ?? null,
    pauseRequested: instance.pauseRequested,
    runNumber: instance.runNumber,
  });

  const mapStepRow = (row: {
    id: { internalId?: bigint } | bigint;
    instanceRef: { internalId?: bigint } | bigint;
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
  }): WorkflowScenarioStepRow => ({
    id: resolveInternalId(row.id, "workflow step"),
    instanceRef: resolveInternalId(row.instanceRef, "workflow step instance"),
    workflowName: row.workflowName,
    instanceId: row.instanceId,
    runNumber: row.runNumber,
    stepKey: row.stepKey,
    name: row.name,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    timeoutMs: row.timeoutMs,
    nextRetryAt: row.nextRetryAt,
    wakeAt: row.wakeAt,
    waitEventType: row.waitEventType,
    result: row.result ?? null,
    errorName: row.errorName ?? null,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const mapEventRow = (row: {
    id: { internalId?: bigint } | bigint;
    instanceRef: { internalId?: bigint } | bigint;
    workflowName: string;
    instanceId: string;
    runNumber: number;
    type: string;
    payload: unknown | null;
    createdAt: Date;
    deliveredAt: Date | null;
    consumedByStepKey: string | null;
  }): WorkflowScenarioEventRow => ({
    id: resolveInternalId(row.id, "workflow event"),
    instanceRef: resolveInternalId(row.instanceRef, "workflow event instance"),
    workflowName: row.workflowName,
    instanceId: row.instanceId,
    runNumber: row.runNumber,
    type: row.type,
    payload: row.payload ?? null,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    consumedByStepKey: row.consumedByStepKey,
  });

  const getInstance = async (workflow: (keyof TRegistry & string) | string, instanceId: string) => {
    const workflowName = resolver.resolveName(String(workflow));
    const instance = await getScenarioInstanceRow(harness, workflowName, instanceId);
    return instance ? mapInstanceRow(instance) : null;
  };

  const getSteps = async (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: { runNumber?: number; order?: "asc" | "desc" },
  ) => {
    const workflowName = resolver.resolveName(String(workflow));
    const instance = await getScenarioInstanceRow(harness, workflowName, instanceId);
    if (!instance) {
      throw new Error("INSTANCE_NOT_FOUND");
    }
    const runNumber = options?.runNumber ?? instance.runNumber;
    const order = options?.order ?? "asc";

    const rows = await harness.db.find("workflow_step", (b) =>
      b
        .whereIndex("idx_workflow_step_history_createdAt", (eb) =>
          eb.and(
            eb("workflowName", "=", workflowName),
            eb("instanceId", "=", instanceId),
            eb("runNumber", "=", runNumber),
          ),
        )
        .orderByIndex("idx_workflow_step_history_createdAt", order),
    );

    return rows.map(mapStepRow);
  };

  const getEvents = async (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: { runNumber?: number; order?: "asc" | "desc" },
  ) => {
    const workflowName = resolver.resolveName(String(workflow));
    const instance = await getScenarioInstanceRow(harness, workflowName, instanceId);
    if (!instance) {
      throw new Error("INSTANCE_NOT_FOUND");
    }
    const runNumber = options?.runNumber ?? instance.runNumber;
    const order = options?.order ?? "asc";

    const rows = await harness.db.find("workflow_event", (b) =>
      b
        .whereIndex("idx_workflow_event_history_createdAt", (eb) =>
          eb.and(
            eb("workflowName", "=", workflowName),
            eb("instanceId", "=", instanceId),
            eb("runNumber", "=", runNumber),
          ),
        )
        .orderByIndex("idx_workflow_event_history_createdAt", order),
    );

    return rows.map(mapEventRow);
  };

  const getStatus = async (workflow: (keyof TRegistry & string) | string, instanceId: string) => {
    const workflowName = resolver.resolveName(String(workflow));
    return await harness.getStatus(workflowName, instanceId);
  };

  const getHistory = async (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: {
      runNumber?: number;
      pageSize?: number;
      stepsCursor?: string;
      eventsCursor?: string;
      order?: "asc" | "desc";
    },
  ): Promise<WorkflowsHistory> => {
    const workflowName = resolver.resolveName(String(workflow));
    const instance = await getScenarioInstanceRow(harness, workflowName, instanceId);
    if (!instance) {
      throw new Error("INSTANCE_NOT_FOUND");
    }

    const runNumber = options?.runNumber ?? instance.runNumber;
    const order = options?.order ?? "asc";

    const stepsRows = await harness.db.find("workflow_step", (b) => {
      let builder = b
        .whereIndex("idx_workflow_step_history_createdAt", (eb) =>
          eb.and(
            eb("workflowName", "=", workflowName),
            eb("instanceId", "=", instanceId),
            eb("runNumber", "=", runNumber),
          ),
        )
        .orderByIndex("idx_workflow_step_history_createdAt", order);

      if (options?.stepsCursor) {
        builder = builder.after(options.stepsCursor);
      }
      if (options?.pageSize) {
        builder = builder.pageSize(options.pageSize);
      }
      return builder;
    });

    const eventsRows = await harness.db.find("workflow_event", (b) => {
      let builder = b
        .whereIndex("idx_workflow_event_history_createdAt", (eb) =>
          eb.and(
            eb("workflowName", "=", workflowName),
            eb("instanceId", "=", instanceId),
            eb("runNumber", "=", runNumber),
          ),
        )
        .orderByIndex("idx_workflow_event_history_createdAt", order);

      if (options?.eventsCursor) {
        builder = builder.after(options.eventsCursor);
      }
      if (options?.pageSize) {
        builder = builder.pageSize(options.pageSize);
      }
      return builder;
    });

    return {
      runNumber,
      steps: stepsRows.map((row) => ({
        id: row.id.toString(),
        runNumber: row.runNumber,
        stepKey: row.stepKey,
        name: row.name,
        type: row.type,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        timeoutMs: row.timeoutMs,
        nextRetryAt: row.nextRetryAt,
        wakeAt: row.wakeAt,
        waitEventType: row.waitEventType,
        result: row.result ?? null,
        error: buildHistoryEntryError(row),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      events: eventsRows.map((row) => ({
        id: row.id.toString(),
        runNumber: row.runNumber,
        type: row.type,
        payload: row.payload ?? null,
        createdAt: row.createdAt,
        deliveredAt: row.deliveredAt,
        consumedByStepKey: row.consumedByStepKey,
      })),
    };
  };

  const getHooks = async (options?: {
    namespace?: string;
    hookName?: string;
    status?: WorkflowScenarioHookRow["status"];
    workflowName?: string;
    instanceId?: string;
  }) => {
    const namespace = options?.namespace ?? "workflows";
    const internalFragment = getInternalFragment(harness.test.adapter);

    const hooks = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace(namespace)] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    return hooks
      .filter((hook) => (options?.hookName ? hook.hookName === options.hookName : true))
      .filter((hook) => (options?.status ? hook.status === options.status : true))
      .filter((hook) => {
        if (!options?.workflowName && !options?.instanceId) {
          return true;
        }
        if (!hook.payload || typeof hook.payload !== "object") {
          return false;
        }
        const payload = hook.payload as Partial<WorkflowEnqueuedHookPayload>;
        if (options.workflowName && payload.workflowName !== options.workflowName) {
          return false;
        }
        if (options.instanceId && payload.instanceId !== options.instanceId) {
          return false;
        }
        return true;
      })
      .map((hook) => ({
        id: resolveInternalId(hook.id, "hook"),
        namespace: hook.namespace,
        hookName: hook.hookName,
        payload: hook.payload,
        status: hook.status as WorkflowScenarioHookRow["status"],
        attempts: hook.attempts,
        maxAttempts: hook.maxAttempts,
        lastAttemptAt: hook.lastAttemptAt,
        nextRetryAt: hook.nextRetryAt,
        error: hook.error ?? null,
        createdAt: hook.createdAt,
        nonce: hook.nonce,
      }));
  };

  return {
    getInstance,
    getSteps,
    getEvents,
    getStatus,
    getHistory,
    internal: {
      getHooks,
    },
  };
};

export async function runScenario<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
>(scenario: WorkflowScenarioDefinition<TRegistry, TVars>): Promise<WorkflowScenarioResult<TVars>> {
  const { adapter, testBuilder, autoTickHooks, ...harnessOptions } = scenario.harness ?? {};

  const harness = await createWorkflowsTestHarness({
    workflows: scenario.workflows,
    adapter: adapter ?? { type: "kysely-sqlite" },
    testBuilder: testBuilder ?? buildDatabaseFragmentsTest(),
    autoTickHooks: autoTickHooks ?? false,
    ...harnessOptions,
  });

  const resolver = createWorkflowResolver(scenario.workflows);
  const context: WorkflowScenarioContext<TRegistry, TVars> = {
    name: scenario.name,
    harness,
    runtime: harness.runtime,
    clock: harness.clock,
    vars: {},
    state: createScenarioState(harness, resolver),
    cleanup: async () => {
      await harness.test.cleanup();
    },
  };

  const fragment = context.harness.fragment as AnyFragnoInstantiatedFragment;
  const callRoute = fragment.callRoute.bind(fragment) as (
    method: string,
    path: string,
    options?: { pathParams?: Record<string, string>; body?: unknown },
  ) => Promise<WorkflowScenarioRouteResponse>;

  const callInstanceRoute = async (path: string, workflowName: string, instanceId: string) =>
    await callRoute("POST", path, { pathParams: { workflowName, instanceId } });

  const buildPayload = async (options: {
    workflow: (keyof TRegistry & string) | string;
    instanceId: string;
    reason: WorkflowEnqueuedHookPayload["reason"];
    runNumber?: number;
    timestamp?: Date;
  }): Promise<WorkflowEnqueuedHookPayload> => {
    const workflowName = resolver.resolveName(String(options.workflow));
    if (options.timestamp) {
      context.clock.set(options.timestamp);
    }

    const instance = await getScenarioInstanceRow(harness, workflowName, options.instanceId);
    if (!instance) {
      throw new Error("INSTANCE_NOT_FOUND");
    }

    return {
      workflowName,
      instanceId: instance.instanceId,
      instanceRef: String(instance.id),
      runNumber: options.runNumber ?? instance.runNumber,
      reason: options.reason,
    };
  };

  let result: WorkflowScenarioResult<TVars> | undefined;
  let scenarioError: unknown;

  try {
    for (const step of scenario.steps) {
      switch (step.type) {
        case "create": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const params = step.params ? await resolveScenarioInput(step.params, context) : undefined;
          const id = step.id ? await resolveScenarioInput(step.id, context) : undefined;
          const instanceId = await context.harness.createInstance(workflowName, {
            ...(id ? { id } : {}),
            ...(params ? { params } : {}),
          });
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = instanceId;
          }
          break;
        }
        case "initializeAndRunUntilIdle": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const params = step.params ? await resolveScenarioInput(step.params, context) : undefined;
          const id = step.id ? await resolveScenarioInput(step.id, context) : undefined;
          const instanceId = await context.harness.createInstance(workflowName, {
            ...(id ? { id } : {}),
            ...(params ? { params } : {}),
          });
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = instanceId;
          }

          const timestamp = step.timestamp
            ? await resolveScenarioInput(step.timestamp, context)
            : undefined;
          const payload = await buildPayload({
            workflow: workflowName,
            instanceId,
            reason: "create",
            ...(timestamp ? { timestamp } : {}),
          });
          const maxTicks = step.maxTicks
            ? await resolveScenarioInput(step.maxTicks, context)
            : undefined;
          const resultTicks = await context.harness.runUntilIdle(
            payload,
            maxTicks ? { maxTicks } : undefined,
          );
          if (step.runStoreAs) {
            (context.vars as Record<string, unknown>)[step.runStoreAs] = resultTicks;
          }
          break;
        }
        case "createBatch": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instances = await resolveScenarioInput(step.instances, context);
          const resultInstances = await context.harness.createBatch(workflowName, instances);
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = resultInstances;
          }
          break;
        }
        case "event": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const event = await resolveScenarioInput(step.event, context);
          const status = await context.harness.sendEvent(workflowName, instanceId, event);
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = status;
          }
          break;
        }
        case "eventAndRunUntilIdle": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const event = await resolveScenarioInput(step.event, context);
          const status = await context.harness.sendEvent(workflowName, instanceId, event);
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = status;
          }

          const timestamp = step.timestamp
            ? await resolveScenarioInput(step.timestamp, context)
            : undefined;
          const payload = await buildPayload({
            workflow: workflowName,
            instanceId,
            reason: "event",
            ...(timestamp ? { timestamp } : {}),
          });
          const maxTicks = step.maxTicks
            ? await resolveScenarioInput(step.maxTicks, context)
            : undefined;
          const resultTicks = await context.harness.runUntilIdle(
            payload,
            maxTicks ? { maxTicks } : undefined,
          );
          if (step.runStoreAs) {
            (context.vars as Record<string, unknown>)[step.runStoreAs] = resultTicks;
          }
          break;
        }
        case "pause": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const response = await callInstanceRoute(
            "/:workflowName/instances/:instanceId/pause",
            workflowName,
            instanceId,
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = response;
          }
          break;
        }
        case "resume": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const response = await callInstanceRoute(
            "/:workflowName/instances/:instanceId/resume",
            workflowName,
            instanceId,
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = response;
          }
          break;
        }
        case "resumeAndRunUntilIdle": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const response = await callInstanceRoute(
            "/:workflowName/instances/:instanceId/resume",
            workflowName,
            instanceId,
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = response;
          }

          const timestamp = step.timestamp
            ? await resolveScenarioInput(step.timestamp, context)
            : undefined;
          const payload = await buildPayload({
            workflow: workflowName,
            instanceId,
            reason: "resume",
            ...(timestamp ? { timestamp } : {}),
          });
          const maxTicks = step.maxTicks
            ? await resolveScenarioInput(step.maxTicks, context)
            : undefined;
          const resultTicks = await context.harness.runUntilIdle(
            payload,
            maxTicks ? { maxTicks } : undefined,
          );
          if (step.runStoreAs) {
            (context.vars as Record<string, unknown>)[step.runStoreAs] = resultTicks;
          }
          break;
        }
        case "terminate": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const response = await callInstanceRoute(
            "/:workflowName/instances/:instanceId/terminate",
            workflowName,
            instanceId,
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = response;
          }
          break;
        }
        case "restart": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const response = await callInstanceRoute(
            "/:workflowName/instances/:instanceId/restart",
            workflowName,
            instanceId,
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = response;
          }
          break;
        }
        case "runCreateUntilIdle": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const timestamp = step.timestamp
            ? await resolveScenarioInput(step.timestamp, context)
            : undefined;
          const payload = await buildPayload({
            workflow: workflowName,
            instanceId,
            reason: "create",
            ...(timestamp ? { timestamp } : {}),
          });
          const maxTicks = step.maxTicks
            ? await resolveScenarioInput(step.maxTicks, context)
            : undefined;
          const resultTicks = await context.harness.runUntilIdle(
            payload,
            maxTicks ? { maxTicks } : undefined,
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = resultTicks;
          }
          break;
        }
        case "runResumeUntilIdle": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const timestamp = step.timestamp
            ? await resolveScenarioInput(step.timestamp, context)
            : undefined;
          const payload = await buildPayload({
            workflow: workflowName,
            instanceId,
            reason: "resume",
            ...(timestamp ? { timestamp } : {}),
          });
          const maxTicks = step.maxTicks
            ? await resolveScenarioInput(step.maxTicks, context)
            : undefined;
          const resultTicks = await context.harness.runUntilIdle(
            payload,
            maxTicks ? { maxTicks } : undefined,
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = resultTicks;
          }
          break;
        }
        case "retryAndRunUntilIdle": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const timestamp = step.timestamp
            ? await resolveScenarioInput(step.timestamp, context)
            : undefined;
          const payload = await buildPayload({
            workflow: workflowName,
            instanceId,
            reason: "retry",
            ...(timestamp ? { timestamp } : {}),
          });
          const maxTicks = step.maxTicks
            ? await resolveScenarioInput(step.maxTicks, context)
            : undefined;
          const resultTicks = await context.harness.runUntilIdle(
            payload,
            maxTicks ? { maxTicks } : undefined,
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = resultTicks;
          }
          break;
        }
        case "tick": {
          let payload: WorkflowEnqueuedHookPayload;
          if (step.payload) {
            if (step.timestamp) {
              const resolvedTimestamp = await resolveScenarioInput(step.timestamp, context);
              context.clock.set(resolvedTimestamp);
            }
            payload = await resolveScenarioInput(step.payload, context);
            resolver.assertName(payload.workflowName);
          } else {
            if (!step.workflow || !step.instanceId || !step.reason) {
              throw new Error(
                "Tick step requires workflow, instanceId, and reason when payload is omitted",
              );
            }
            const workflow = await resolveScenarioInput(step.workflow, context);
            const instanceId = await resolveScenarioInput(step.instanceId, context);
            const reason = await resolveScenarioInput(step.reason, context);
            const timestamp = step.timestamp
              ? await resolveScenarioInput(step.timestamp, context)
              : undefined;
            payload = await buildPayload({
              workflow,
              instanceId,
              reason,
              ...(timestamp ? { timestamp } : {}),
            });
          }

          const processed = await context.harness.tick(payload);
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = processed;
          }
          break;
        }
        case "runUntilIdle": {
          let payload: WorkflowEnqueuedHookPayload;
          if (step.payload) {
            if (step.timestamp) {
              const resolvedTimestamp = await resolveScenarioInput(step.timestamp, context);
              context.clock.set(resolvedTimestamp);
            }
            payload = await resolveScenarioInput(step.payload, context);
            resolver.assertName(payload.workflowName);
          } else {
            if (!step.workflow || !step.instanceId || !step.reason) {
              throw new Error(
                "runUntilIdle step requires workflow, instanceId, and reason when payload is omitted",
              );
            }
            const workflow = await resolveScenarioInput(step.workflow, context);
            const instanceId = await resolveScenarioInput(step.instanceId, context);
            const reason = await resolveScenarioInput(step.reason, context);
            const timestamp = step.timestamp
              ? await resolveScenarioInput(step.timestamp, context)
              : undefined;
            payload = await buildPayload({
              workflow,
              instanceId,
              reason,
              ...(timestamp ? { timestamp } : {}),
            });
          }

          const maxTicks = step.maxTicks
            ? await resolveScenarioInput(step.maxTicks, context)
            : undefined;

          const resultTicks = await context.harness.runUntilIdle(
            payload,
            maxTicks ? { maxTicks } : undefined,
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = resultTicks;
          }
          break;
        }
        case "advanceTimeAndRunUntilIdle": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const advanceBy = step.advanceBy
            ? await resolveScenarioInput(step.advanceBy, context)
            : undefined;
          const setTo = step.setTo ? await resolveScenarioInput(step.setTo, context) : undefined;

          if (advanceBy && setTo !== undefined) {
            throw new Error(
              "advanceTimeAndRunUntilIdle requires either advanceBy or setTo (not both)",
            );
          }

          if (advanceBy) {
            context.clock.advanceBy(advanceBy);
          } else {
            if (setTo === undefined) {
              throw new Error(
                "advanceTimeAndRunUntilIdle requires either advanceBy (relative) or setTo (absolute)",
              );
            }
            context.clock.set(setTo);
          }

          const payload = await buildPayload({
            workflow: workflowName,
            instanceId,
            reason: "wake",
          });
          const maxTicks = step.maxTicks
            ? await resolveScenarioInput(step.maxTicks, context)
            : undefined;
          const resultTicks = await context.harness.runUntilIdle(
            payload,
            maxTicks ? { maxTicks } : undefined,
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = resultTicks;
          }
          break;
        }
        case "read": {
          const value = await step.read(context);
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = value;
          }
          break;
        }
        case "assert": {
          await step.assert(context);
          break;
        }
        default: {
          const exhaustive: never = step;
          throw new Error(`Unsupported scenario step: ${String(exhaustive)}`);
        }
      }
    }

    result = {
      name: context.name,
      vars: context.vars,
      runtime: context.runtime,
      clock: context.clock,
    };
  } catch (error) {
    scenarioError = error;
  }

  try {
    await context.cleanup();
  } catch (cleanupError) {
    if (scenarioError) {
      throw new AggregateError([scenarioError, cleanupError], "Scenario failed and cleanup failed");
    }
    throw cleanupError;
  }

  if (scenarioError) {
    throw scenarioError;
  }

  if (!result) {
    throw new Error("Scenario did not produce a result");
  }

  return result;
}
