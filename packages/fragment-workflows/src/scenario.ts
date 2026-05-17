import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";

import type { AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import {
  buildDatabaseFragmentsTest,
  drainDurableHooks,
  type DatabaseFragmentsTestBuilder,
  type SupportedAdapter,
} from "@fragno-dev/test";

import { createWorkflowStepLivePump, workflowStepLivePumpKey } from "./runner/step-live-pump";
import type { WorkflowStepLivePump } from "./runner/step-live-pump";
import { workflowsSchema } from "./schema";
import {
  createWorkflowsTestHarness,
  type WorkflowsHistory,
  type WorkflowsTestClock,
  type WorkflowsTestHarness,
  type WorkflowsTestHarnessOptions,
  type WorkflowsTestRuntime,
  type WorkflowsTestRunner,
} from "./test";
import type {
  InstanceStatus,
  WorkflowDuration,
  WorkflowEnqueuedHookPayload,
  WorkflowsRegistry,
} from "./workflow";

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
};

export type WorkflowScenarioStepRow = {
  id: bigint;
  instanceRef: bigint;
  workflowName: string;
  instanceId: string;
  stepKey: string;
  parentStepKey: string | null;
  depth: number;
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
  type: string;
  payload: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

export type WorkflowScenarioEmissionRow = {
  id: bigint;
  instanceRef: bigint;
  workflowName: string;
  instanceId: string;
  stepKey: string;
  epoch: string;
  sequence: number;
  actor: "user" | "system" | string;
  payload: unknown | null;
  createdAt: Date;
};

export type WorkflowScenarioObservedEmission<TPayload = unknown> = {
  workflowName: string;
  instanceId: string;
  stepKey: string;
  epoch: string;
  id: string;
  sequence: number;
  actor: "user" | "system" | string;
  payload: TPayload;
};

export type WorkflowScenarioState<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> = {
  getInstance: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
  ) => Promise<WorkflowScenarioInstanceRow | null>;
  getSteps: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: { order?: "asc" | "desc" },
  ) => Promise<WorkflowScenarioStepRow[]>;
  getEvents: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: { order?: "asc" | "desc" },
  ) => Promise<WorkflowScenarioEventRow[]>;
  getEmissions: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: { order?: "asc" | "desc"; actor?: "user" | "system" | string; stepKey?: string },
  ) => Promise<WorkflowScenarioEmissionRow[]>;
  getStatus: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
  ) => Promise<InstanceStatus>;
  getHistory: (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: {
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
  | WorkflowScenarioRunCreateUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioRunResumeUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioRetryAndRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioTickStep<TRegistry, TVars>
  | WorkflowScenarioRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioAdvanceTimeAndRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioWaitForControlStep<TRegistry, TVars>
  | WorkflowScenarioResolveControlStep<TRegistry, TVars>
  | WorkflowScenarioRejectControlStep<TRegistry, TVars>
  | WorkflowScenarioCaptureEmissionsStep<TRegistry, TVars>
  | WorkflowScenarioFlushEmissionsStep<TRegistry, TVars>
  | WorkflowScenarioWaitForEmissionStep<TRegistry, TVars>
  | WorkflowScenarioStopEmissionCaptureStep<TVars>
  | WorkflowScenarioDrainHooksStep
  | WorkflowScenarioKillRunnerStep
  | WorkflowScenarioRestartRunnerStep
  | WorkflowScenarioKillAndRestartRunnerStep
  | WorkflowScenarioWithRunnerStep<TRegistry, TVars>
  | WorkflowScenarioWithRunnersStep<TRegistry, TVars>
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
  /**
   * When set, used as createdAt for the event. Makes ordering deterministic and tests non-flaky.
   */
  timestamp?: ScenarioInput<Date, TRegistry, TVars>;
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
  /**
   * When set, used as createdAt for the event. Makes ordering deterministic and tests non-flaky.
   */
  eventTimestamp?: ScenarioInput<Date, TRegistry, TVars>;
  /**
   * When set, used as the tick timestamp for runUntilIdle (e.g. for clock-driven scenarios).
   */
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

export type WorkflowScenarioWaitForControlStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "waitForControl";
  key: ScenarioInput<string, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioResolveControlStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "resolveControl";
  key: ScenarioInput<string, TRegistry, TVars>;
  value?: ScenarioInput<unknown, TRegistry, TVars>;
};

export type WorkflowScenarioRejectControlStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "rejectControl";
  key: ScenarioInput<string, TRegistry, TVars>;
  error?: ScenarioInput<unknown, TRegistry, TVars>;
};

export type WorkflowScenarioCaptureEmissionsStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "captureEmissions";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  storeAs: keyof TVars & string;
};

export type WorkflowScenarioFlushEmissionsStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "flushEmissions";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
};

export type WorkflowScenarioWaitForEmissionStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "waitForEmission";
  capture: keyof TVars & string;
  match?: (
    message: WorkflowScenarioObservedEmission,
    ctx: WorkflowScenarioContext<TRegistry, TVars>,
  ) => boolean;
  timeoutMs?: ScenarioInput<number, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioStopEmissionCaptureStep<TVars extends WorkflowScenarioVars> = {
  type: "stopEmissionCapture";
  capture: keyof TVars & string;
};

export type WorkflowScenarioDrainHooksStep = {
  type: "drainHooks";
};

export type WorkflowScenarioKillRunnerStep = {
  type: "killRunner";
};

export type WorkflowScenarioRestartRunnerStep = {
  type: "restartRunner";
};

export type WorkflowScenarioKillAndRestartRunnerStep = {
  type: "killAndRestartRunner";
};

export type WorkflowScenarioWithRunnerStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "withRunner";
  steps: WorkflowScenarioStep<TRegistry, TVars>[];
};

export type WorkflowScenarioWithRunnersStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "withRunners";
  runners: Record<string, WorkflowScenarioStep<TRegistry, TVars>[]>;
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
  waitForControl: (
    input: StepInput<WorkflowScenarioWaitForControlStep<TRegistry, TVars>>,
  ): WorkflowScenarioWaitForControlStep<TRegistry, TVars> => ({
    type: "waitForControl",
    ...input,
  }),
  resolveControl: (
    input: StepInput<WorkflowScenarioResolveControlStep<TRegistry, TVars>>,
  ): WorkflowScenarioResolveControlStep<TRegistry, TVars> => ({
    type: "resolveControl",
    ...input,
  }),
  rejectControl: (
    input: StepInput<WorkflowScenarioRejectControlStep<TRegistry, TVars>>,
  ): WorkflowScenarioRejectControlStep<TRegistry, TVars> => ({
    type: "rejectControl",
    ...input,
  }),
  captureEmissions: (
    input: StepInput<WorkflowScenarioCaptureEmissionsStep<TRegistry, TVars>>,
  ): WorkflowScenarioCaptureEmissionsStep<TRegistry, TVars> => ({
    type: "captureEmissions",
    ...input,
  }),
  flushEmissions: (
    input: StepInput<WorkflowScenarioFlushEmissionsStep<TRegistry, TVars>>,
  ): WorkflowScenarioFlushEmissionsStep<TRegistry, TVars> => ({
    type: "flushEmissions",
    ...input,
  }),
  waitForEmission: (
    input: StepInput<WorkflowScenarioWaitForEmissionStep<TRegistry, TVars>>,
  ): WorkflowScenarioWaitForEmissionStep<TRegistry, TVars> => ({
    type: "waitForEmission",
    ...input,
  }),
  stopEmissionCapture: (
    input: StepInput<WorkflowScenarioStopEmissionCaptureStep<TVars>>,
  ): WorkflowScenarioStopEmissionCaptureStep<TVars> => ({
    type: "stopEmissionCapture",
    ...input,
  }),
  drainHooks: (): WorkflowScenarioDrainHooksStep => ({
    type: "drainHooks",
  }),
  killRunner: (): WorkflowScenarioKillRunnerStep => ({
    type: "killRunner",
  }),
  restartRunner: (): WorkflowScenarioRestartRunnerStep => ({
    type: "restartRunner",
  }),
  killAndRestartRunner: (): WorkflowScenarioKillAndRestartRunnerStep => ({
    type: "killAndRestartRunner",
  }),
  withRunner: (
    steps: WorkflowScenarioStep<TRegistry, TVars>[],
  ): WorkflowScenarioWithRunnerStep<TRegistry, TVars> => ({
    type: "withRunner",
    steps,
  }),
  withRunners: (
    runners: Record<string, WorkflowScenarioStep<TRegistry, TVars>[]>,
  ): WorkflowScenarioWithRunnersStep<TRegistry, TVars> => ({
    type: "withRunners",
    runners,
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

/** Row shape from `workflow_instance` reads in scenario harness (matches mapInstanceRow input). */
type ScenarioDbWorkflowInstance = {
  id: { internalId?: bigint } | bigint;
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
};

const getScenarioInstanceRow = async <TRegistry extends WorkflowsRegistry>(
  harness: WorkflowsTestHarness<TRegistry>,
  workflowName: string,
  instanceId: string,
): Promise<ScenarioDbWorkflowInstance | null> => {
  const rows = (
    await harness.db
      .createUnitOfWork("scenario-instance")
      .forSchema(workflowsSchema)
      .find("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
          eb.and(eb("workflowName", "=", workflowName), eb("id", "=", instanceId)),
        ),
      )
      .executeRetrieve()
  )[0];
  const [instance] = rows;
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
  }): WorkflowScenarioInstanceRow => ({
    id: resolveInternalId(instance.id, "workflow instance"),
    instanceId: instance.id.toString(),
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
  });

  const mapStepRow = (
    row: {
      id: { internalId?: bigint } | bigint;
      instanceRef: { internalId?: bigint } | bigint;
      stepKey: string;
      parentStepKey: string | null;
      depth: number;
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
    },
    context: { workflowName: string; instanceId: string },
  ): WorkflowScenarioStepRow => ({
    id: resolveInternalId(row.id, "workflow step"),
    instanceRef: resolveInternalId(row.instanceRef, "workflow step instance"),
    workflowName: context.workflowName,
    instanceId: context.instanceId,
    stepKey: row.stepKey,
    parentStepKey: row.parentStepKey,
    depth: row.depth,
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

  const mapEventRow = (
    row: {
      id: { internalId?: bigint } | bigint;
      instanceRef: { internalId?: bigint } | bigint;
      type: string;
      payload: unknown | null;
      createdAt: Date;
      deliveredAt: Date | null;
      consumedByStepKey: string | null;
    },
    context: { workflowName: string; instanceId: string },
  ): WorkflowScenarioEventRow => ({
    id: resolveInternalId(row.id, "workflow event"),
    instanceRef: resolveInternalId(row.instanceRef, "workflow event instance"),
    workflowName: context.workflowName,
    instanceId: context.instanceId,
    type: row.type,
    payload: row.payload ?? null,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    consumedByStepKey: row.consumedByStepKey,
  });

  const mapEmissionRow = (
    row: {
      id: { internalId?: bigint } | bigint;
      instanceRef: { internalId?: bigint } | bigint;
      stepKey: string;
      epoch: string;
      sequence: number;
      actor: string;
      payload: unknown | null;
      createdAt: Date;
    },
    context: { workflowName: string; instanceId: string },
  ): WorkflowScenarioEmissionRow => ({
    id: resolveInternalId(row.id, "workflow step emission"),
    instanceRef: resolveInternalId(row.instanceRef, "workflow step emission instance"),
    workflowName: context.workflowName,
    instanceId: context.instanceId,
    stepKey: row.stepKey,
    epoch: row.epoch,
    sequence: row.sequence,
    actor: row.actor,
    payload: row.payload ?? null,
    createdAt: row.createdAt,
  });

  const getInstance = async (workflow: (keyof TRegistry & string) | string, instanceId: string) => {
    const workflowName = resolver.resolveName(String(workflow));
    const instance = await getScenarioInstanceRow(harness, workflowName, instanceId);
    return instance ? mapInstanceRow(instance) : null;
  };

  const getSteps = async (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: { order?: "asc" | "desc" },
  ) => {
    const workflowName = resolver.resolveName(String(workflow));
    const instance = await getScenarioInstanceRow(harness, workflowName, instanceId);
    if (!instance) {
      throw new Error("INSTANCE_NOT_FOUND");
    }
    const order = options?.order ?? "asc";
    const instanceRef = resolveInternalId(instance.id, "workflow instance");

    const rows = await (async () => {
      return (
        await harness.db
          .createUnitOfWork("scenario-steps")
          .forSchema(workflowsSchema)
          .find("workflow_step", (b) =>
            b
              .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                eb("instanceRef", "=", instanceRef),
              )
              .orderByIndex("idx_workflow_step_instanceRef_createdAt", order),
          )
          .executeRetrieve()
      )[0];
    })();

    return rows.map((row) =>
      mapStepRow(row as Parameters<typeof mapStepRow>[0], { workflowName, instanceId }),
    );
  };

  const getEvents = async (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: { order?: "asc" | "desc" },
  ) => {
    const workflowName = resolver.resolveName(String(workflow));
    const instance = await getScenarioInstanceRow(harness, workflowName, instanceId);
    if (!instance) {
      throw new Error("INSTANCE_NOT_FOUND");
    }
    const order = options?.order ?? "asc";
    const instanceRef = resolveInternalId(instance.id, "workflow instance");

    const rows = await (async () => {
      return (
        await harness.db
          .createUnitOfWork("scenario-events")
          .forSchema(workflowsSchema)
          .find("workflow_event", (b) =>
            b
              .whereIndex("idx_workflow_event_instanceRef_createdAt", (eb) =>
                eb("instanceRef", "=", instanceRef),
              )
              .orderByIndex("idx_workflow_event_instanceRef_createdAt", order),
          )
          .executeRetrieve()
      )[0];
    })();

    return rows.map((row) =>
      mapEventRow(row as Parameters<typeof mapEventRow>[0], { workflowName, instanceId }),
    );
  };

  const getEmissions = async (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: { order?: "asc" | "desc"; actor?: "user" | "system" | string; stepKey?: string },
  ) => {
    const workflowName = resolver.resolveName(String(workflow));
    const instance = await getScenarioInstanceRow(harness, workflowName, instanceId);
    if (!instance) {
      throw new Error("INSTANCE_NOT_FOUND");
    }
    const order = options?.order ?? "asc";
    const actor = options?.actor;
    const instanceRef = resolveInternalId(instance.id, "workflow instance");

    const rows = (
      await harness.db
        .createUnitOfWork("scenario-emissions")
        .forSchema(workflowsSchema)
        .find("workflow_step_emission", (b) => {
          if (actor) {
            return b
              .whereIndex("idx_workflow_step_emission_instance_actor_createdAt_sequence_id", (eb) =>
                eb.and(eb("instanceRef", "=", instanceRef), eb("actor", "=", actor)),
              )
              .orderByIndex(
                "idx_workflow_step_emission_instance_actor_createdAt_sequence_id",
                order,
              );
          }

          return b
            .whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
              eb("instanceRef", "=", instanceRef),
            )
            .orderByIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", order);
        })
        .executeRetrieve()
    )[0];

    return rows
      .filter((row) => (options?.stepKey ? row.stepKey === options.stepKey : true))
      .map((row) =>
        mapEmissionRow(row as Parameters<typeof mapEmissionRow>[0], { workflowName, instanceId }),
      );
  };

  const getStatus = async (workflow: (keyof TRegistry & string) | string, instanceId: string) => {
    const workflowName = resolver.resolveName(String(workflow));
    return await harness.getStatus(workflowName, instanceId);
  };

  const getHistory = async (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: {
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
    const order = options?.order ?? "asc";
    const instanceRef = resolveInternalId(instance.id, "workflow instance");

    const stepsRows = await (async () => {
      return (
        await harness.db
          .createUnitOfWork("scenario-history-steps")
          .forSchema(workflowsSchema)
          .find("workflow_step", (b) => {
            let builder = b
              .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                eb("instanceRef", "=", instanceRef),
              )
              .orderByIndex("idx_workflow_step_instanceRef_createdAt", order);

            if (options?.stepsCursor) {
              builder = builder.after(options.stepsCursor);
            }
            if (options?.pageSize) {
              builder = builder.pageSize(options.pageSize);
            }
            return builder;
          })
          .executeRetrieve()
      )[0];
    })();

    const eventsRows = await (async () => {
      return (
        await harness.db
          .createUnitOfWork("scenario-history-events")
          .forSchema(workflowsSchema)
          .find("workflow_event", (b) => {
            let builder = b
              .whereIndex("idx_workflow_event_instanceRef_createdAt", (eb) =>
                eb("instanceRef", "=", instanceRef),
              )
              .orderByIndex("idx_workflow_event_instanceRef_createdAt", order);

            if (options?.eventsCursor) {
              builder = builder.after(options.eventsCursor);
            }
            if (options?.pageSize) {
              builder = builder.pageSize(options.pageSize);
            }
            return builder;
          })
          .executeRetrieve()
      )[0];
    })();

    const emissionsRows = await (async () => {
      return (
        await harness.db
          .createUnitOfWork("scenario-history-emissions")
          .forSchema(workflowsSchema)
          .find("workflow_step_emission", (b) =>
            b
              .whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
                eb("instanceRef", "=", instanceRef),
              )
              .orderByIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", order),
          )
          .executeRetrieve()
      )[0];
    })();

    return {
      steps: (
        stepsRows as Array<{
          id: { toString(): string };
          stepKey: string;
          parentStepKey: string | null;
          depth: number;
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
        }>
      ).map((row) => ({
        id: row.id.toString(),
        stepKey: row.stepKey,
        parentStepKey: row.parentStepKey,
        depth: row.depth,
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
      events: (
        eventsRows as Array<{
          id: { toString(): string };
          type: string;
          payload: unknown | null;
          createdAt: Date;
          deliveredAt: Date | null;
          consumedByStepKey: string | null;
        }>
      ).map((row) => ({
        id: row.id.toString(),
        type: row.type,
        payload: row.payload ?? null,
        createdAt: row.createdAt,
        deliveredAt: row.deliveredAt,
        consumedByStepKey: row.consumedByStepKey,
      })),
      emissions: (
        emissionsRows as Array<{
          id: { toString(): string };
          stepKey: string;
          epoch: string;
          sequence: number;
          actor: string;
          payload: unknown | null;
          createdAt: Date;
        }>
      ).map((row) => ({
        id: row.id.toString(),
        stepKey: row.stepKey,
        epoch: row.epoch,
        sequence: row.sequence,
        actor: row.actor,
        payload: row.payload ?? null,
        createdAt: row.createdAt,
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
    getEmissions,
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
  const { adapter, testBuilder, autoTickHooks, fragmentConfig, ...harnessOptions } =
    scenario.harness ?? {};
  const scenarioUsesEmissions = (steps: WorkflowScenarioStep<TRegistry, TVars>[]): boolean =>
    steps.some((step) => {
      switch (step.type) {
        case "captureEmissions":
        case "flushEmissions":
        case "waitForEmission":
          return true;
        case "withRunner":
          return scenarioUsesEmissions(step.steps);
        case "withRunners":
          return Object.values(step.runners).some((runnerSteps) =>
            scenarioUsesEmissions(runnerSteps),
          );
        default:
          return false;
      }
    });
  const stepEmissions =
    fragmentConfig?.stepEmissions ?? new BufferedPumpRegistry<WorkflowStepLivePump>();
  const shouldInjectStepEmissions =
    !!fragmentConfig?.stepEmissions || scenarioUsesEmissions(scenario.steps);

  const harness = await createWorkflowsTestHarness({
    workflows: scenario.workflows,
    adapter: adapter ?? { type: "kysely-sqlite" },
    testBuilder: testBuilder ?? buildDatabaseFragmentsTest(),
    autoTickHooks: autoTickHooks ?? false,
    ...harnessOptions,
    fragmentConfig: shouldInjectStepEmissions
      ? { ...fragmentConfig, stepEmissions }
      : fragmentConfig,
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
      while (emissionCaptureCleanups.length > 0) {
        await emissionCaptureCleanups.pop()?.();
      }
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

  const emissionCaptureCleanups: Array<() => void | Promise<void>> = [];
  const emissionCaptureWaiters = new Map<string, Array<() => void>>();

  const notifyEmissionCaptureWaiters = (capture: string) => {
    const waiters = emissionCaptureWaiters.get(capture)?.splice(0) ?? [];
    for (const resolve of waiters) {
      resolve();
    }
  };

  const buildPayload = async (options: {
    workflow: (keyof TRegistry & string) | string;
    instanceId: string;
    reason: WorkflowEnqueuedHookPayload["reason"];
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
      instanceId: instance.id.toString(),
      instanceRef: String(instance.id),
      reason: options.reason,
    };
  };

  let hasUsedExplicitRunnerScope = false;
  const isTopLevelObservationStepAfterExplicitRunners = (
    step: WorkflowScenarioStep<TRegistry, TVars>,
  ): boolean => {
    switch (step.type) {
      case "read":
      case "captureEmissions":
      case "flushEmissions":
      case "waitForEmission":
      case "stopEmissionCapture":
      case "drainHooks":
      case "assert":
        return true;
      default:
        return false;
    }
  };

  const executeSteps = async (
    scenarioSteps: WorkflowScenarioStep<TRegistry, TVars>[],
    runner: WorkflowsTestRunner,
    options?: { topLevel?: boolean },
  ) => {
    for (const step of scenarioSteps) {
      if (
        options?.topLevel &&
        hasUsedExplicitRunnerScope &&
        !isTopLevelObservationStepAfterExplicitRunners(step)
      ) {
        throw new Error(
          `TOP_LEVEL_SCENARIO_STEP_AFTER_EXPLICIT_RUNNER: ${step.type}. ` +
            "All runner-affecting work must be part of the first withRunner(...) or withRunners(...) block.",
        );
      }

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
          const resultTicks = await runner.runUntilIdle(
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
          const timestamp = step.timestamp
            ? await resolveScenarioInput(step.timestamp, context)
            : undefined;
          const status = await context.harness.sendEvent(workflowName, instanceId, {
            ...event,
            ...(timestamp ? { createdAt: timestamp } : {}),
          });
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
          const eventTimestamp = step.eventTimestamp
            ? await resolveScenarioInput(step.eventTimestamp, context)
            : undefined;
          const status = await context.harness.sendEvent(workflowName, instanceId, {
            ...event,
            ...(eventTimestamp ? { createdAt: eventTimestamp } : {}),
          });
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
          const resultTicks = await runner.runUntilIdle(
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
          const resultTicks = await runner.runUntilIdle(
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
          const resultTicks = await runner.runUntilIdle(
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
          const resultTicks = await runner.runUntilIdle(
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
          let retryAt: Date | undefined;
          if (!timestamp) {
            const instance = await getScenarioInstanceRow(harness, workflowName, instanceId);
            if (instance) {
              const instanceRef = resolveInternalId(instance.id, "workflow instance");
              const steps = await (async () => {
                return (
                  await harness.db
                    .createUnitOfWork("scenario-retry-steps")
                    .forSchema(workflowsSchema)
                    .find("workflow_step", (b) =>
                      b
                        .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                          eb("instanceRef", "=", instanceRef),
                        )
                        .orderByIndex("idx_workflow_step_instanceRef_createdAt", "asc"),
                    )
                    .executeRetrieve()
                )[0];
              })();
              let dueAt: Date | null = null;
              for (const step of steps as Array<{ status: string; nextRetryAt: Date | null }>) {
                if (step.status !== "waiting" || !step.nextRetryAt) {
                  continue;
                }
                if (!dueAt || step.nextRetryAt < dueAt) {
                  dueAt = step.nextRetryAt;
                }
              }
              if (dueAt) {
                retryAt = dueAt;
              }
            }
          }
          const payload = await buildPayload({
            workflow: workflowName,
            instanceId,
            reason: "retry",
            ...((timestamp ?? retryAt) ? { timestamp: timestamp ?? retryAt } : {}),
          });
          const maxTicks = step.maxTicks
            ? await resolveScenarioInput(step.maxTicks, context)
            : undefined;
          const resultTicks = await runner.runUntilIdle(
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

          const processed = await runner.tick(payload);
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

          const resultTicks = await runner.runUntilIdle(
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
          const advanceBy =
            step.advanceBy !== undefined
              ? await resolveScenarioInput(step.advanceBy, context)
              : undefined;
          const setTo = step.setTo ? await resolveScenarioInput(step.setTo, context) : undefined;

          if (advanceBy !== undefined && setTo !== undefined) {
            throw new Error(
              "advanceTimeAndRunUntilIdle requires either advanceBy or setTo (not both)",
            );
          }

          if (advanceBy !== undefined) {
            context.clock.advanceBy(advanceBy);
          } else {
            if (setTo === undefined) {
              throw new Error(
                "advanceTimeAndRunUntilIdle requires either advanceBy (relative) or setTo (absolute)",
              );
            }
            context.clock.set(setTo);
          }

          let wakeAt: Date | undefined;
          const instance = await getScenarioInstanceRow(harness, workflowName, instanceId);
          if (instance) {
            const instanceRef = resolveInternalId(instance.id, "workflow instance");
            const steps = await (async () => {
              return (
                await harness.db
                  .createUnitOfWork("scenario-wake-steps")
                  .forSchema(workflowsSchema)
                  .find("workflow_step", (b) =>
                    b
                      .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                        eb("instanceRef", "=", instanceRef),
                      )
                      .orderByIndex("idx_workflow_step_instanceRef_createdAt", "asc"),
                  )
                  .executeRetrieve()
              )[0];
            })();
            let dueAt: Date | null = null;
            for (const step of steps as Array<{ status: string; wakeAt: Date | null }>) {
              if (step.status !== "waiting" || !step.wakeAt) {
                continue;
              }
              if (!dueAt || step.wakeAt < dueAt) {
                dueAt = step.wakeAt;
              }
            }
            if (dueAt) {
              wakeAt = dueAt;
            }
          }

          const payload = await buildPayload({
            workflow: workflowName,
            instanceId,
            reason: "wake",
            ...(wakeAt ? { timestamp: wakeAt } : {}),
          });
          const maxTicks = step.maxTicks
            ? await resolveScenarioInput(step.maxTicks, context)
            : undefined;
          const resultTicks = await runner.runUntilIdle(
            payload,
            maxTicks ? { maxTicks } : undefined,
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = resultTicks;
          }
          break;
        }
        case "waitForControl": {
          const key = await resolveScenarioInput(step.key, context);
          const value = await context.runtime.controls.wait(key);
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = value;
          }
          break;
        }
        case "resolveControl": {
          const key = await resolveScenarioInput(step.key, context);
          const value =
            "value" in step ? await resolveScenarioInput(step.value, context) : undefined;
          context.runtime.controls.resolve(key, value);
          break;
        }
        case "rejectControl": {
          const key = await resolveScenarioInput(step.key, context);
          const error =
            "error" in step ? await resolveScenarioInput(step.error, context) : undefined;
          context.runtime.controls.reject(key, error);
          break;
        }
        case "captureEmissions": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const messages: WorkflowScenarioObservedEmission[] = [];
          (context.vars as Record<string, unknown>)[step.storeAs] = messages;
          const { busHandle, unsubscribe } = await context.harness.fragment.inContext(function () {
            const handle = stepEmissions.getOrCreate(
              workflowStepLivePumpKey(workflowName, instanceId),
              () =>
                createWorkflowStepLivePump({
                  handlerTx: this.handlerTx,
                  workflowName,
                  instanceId,
                }),
            );
            handle.pump.setHandlerTx(this.handlerTx);
            const unsubscribe = handle.pump.observe((message) => {
              messages.push({ workflowName, instanceId, ...message });
              notifyEmissionCaptureWaiters(step.storeAs);
            });
            return { busHandle: handle, unsubscribe };
          });
          emissionCaptureCleanups.push(async () => {
            unsubscribe();
            await busHandle.close();
          });
          break;
        }
        case "flushEmissions": {
          const workflowName = resolver.resolveName(
            String(await resolveScenarioInput(step.workflow, context)),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          await context.harness.fragment.inContext(async function () {
            const handle = stepEmissions.getOrCreate(
              workflowStepLivePumpKey(workflowName, instanceId),
              () =>
                createWorkflowStepLivePump({
                  handlerTx: this.handlerTx,
                  workflowName,
                  instanceId,
                }),
            );
            handle.pump.setHandlerTx(this.handlerTx);
            await handle.waitForNextFlushAndClose();
          });
          break;
        }
        case "waitForEmission": {
          const capture = String(step.capture);
          const timeoutMs = step.timeoutMs
            ? await resolveScenarioInput(step.timeoutMs, context)
            : 2_000;
          const findMatch = () => {
            const messages = ((context.vars as Record<string, unknown>)[capture] ?? []) as
              | WorkflowScenarioObservedEmission[]
              | unknown[];
            return (messages as WorkflowScenarioObservedEmission[]).find((message) =>
              step.match ? step.match(message, context) : true,
            );
          };

          let matched = findMatch();
          if (!matched) {
            const deadline = Date.now() + timeoutMs;
            while (!matched && Date.now() < deadline) {
              await new Promise<void>((resolve) => {
                const waiters = emissionCaptureWaiters.get(capture) ?? [];
                waiters.push(resolve);
                emissionCaptureWaiters.set(capture, waiters);
                setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))).unref?.();
              });
              matched = findMatch();
            }
          }
          if (!matched) {
            throw new Error(`EMISSION_NOT_OBSERVED: ${capture}`);
          }
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = matched;
          }
          break;
        }
        case "stopEmissionCapture": {
          const capture = String(step.capture);
          notifyEmissionCaptureWaiters(capture);
          const cleanup = emissionCaptureCleanups.pop();
          await cleanup?.();
          break;
        }
        case "drainHooks": {
          await drainDurableHooks(context.harness.fragment);
          break;
        }
        case "killRunner": {
          await runner.kill();
          break;
        }
        case "restartRunner": {
          await runner.restart();
          break;
        }
        case "killAndRestartRunner": {
          await runner.killAndRestart();
          break;
        }
        case "withRunner": {
          if (options?.topLevel) {
            hasUsedExplicitRunnerScope = true;
          }
          await executeSteps(step.steps, context.harness.createRunner());
          break;
        }
        case "withRunners": {
          if (options?.topLevel) {
            hasUsedExplicitRunnerScope = true;
          }
          await Promise.all(
            Object.values(step.runners).map((runnerSteps) =>
              executeSteps(runnerSteps, context.harness.createRunner()),
            ),
          );
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
  };

  let result: WorkflowScenarioResult<TVars> | undefined;
  let scenarioError: unknown;

  try {
    await executeSteps(scenario.steps, context.harness.createRunner(), { topLevel: true });

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
