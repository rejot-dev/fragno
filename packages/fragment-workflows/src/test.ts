import {
  instantiate,
  type AnyFragnoInstantiatedFragment,
  type FragnoRuntime,
} from "@fragno-dev/core";
import type { DatabaseFragmentsTestBuilder, SupportedAdapter, TestContext } from "@fragno-dev/test";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import { createWorkflowsRunner } from "./runner";
import type {
  InstanceStatus,
  InstanceStatusWithOutput,
  RunnerTickOptions,
  WorkflowDuration,
  WorkflowOutputFromEntry,
  WorkflowParamsFromEntry,
  WorkflowsFragmentConfig,
  WorkflowsRegistry,
} from "./workflow";
import { parseDurationMs } from "./utils";

export type WorkflowsHistoryStep = {
  id: string;
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
  error?: { name: string; message: string };
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowsHistoryEvent = {
  id: string;
  runNumber: number;
  type: string;
  payload: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

export type WorkflowsHistoryLog = {
  id: string;
  runNumber: number;
  stepKey: string | null;
  attempt: number | null;
  level: "debug" | "info" | "warn" | "error";
  category: string;
  message: string;
  data: unknown | null;
  createdAt: Date;
};

export type WorkflowsHistory = {
  runNumber: number;
  steps: WorkflowsHistoryStep[];
  events: WorkflowsHistoryEvent[];
  stepsCursor?: string;
  stepsHasNextPage: boolean;
  eventsCursor?: string;
  eventsHasNextPage: boolean;
  logs?: WorkflowsHistoryLog[];
  logsCursor?: string;
  logsHasNextPage?: boolean;
};

export type WorkflowsTestClock = {
  now: () => Date;
  set: (timestamp: Date | number) => Date;
  advanceBy: (duration: WorkflowDuration) => Date;
};

export type WorkflowsTestRuntime = FragnoRuntime & {
  time: WorkflowsTestClock;
};

export type WorkflowsTestHarnessOptions<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> = {
  workflows: TRegistry;
  adapter: SupportedAdapter;
  /**
   * Builder returned by `buildDatabaseFragmentsTest()` from @fragno-dev/test.
   */
  testBuilder: DatabaseFragmentsTestBuilder<{}, undefined>;
  clockStartAt?: Date | number;
  runtime?: WorkflowsTestRuntime;
  randomSeed?: number;
  autoTickHooks?: boolean;
  fragmentConfig?: Omit<
    WorkflowsFragmentConfig<TRegistry>,
    "workflows" | "runner" | "enableRunnerTick" | "runtime"
  >;
  runnerOptions?: {
    runnerId?: string;
    leaseMs?: number;
  };
};

export type WorkflowsTestHarness<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> = {
  fragment: AnyFragnoInstantiatedFragment;
  db: SimpleQueryInterface<typeof workflowsSchema>;
  runner: ReturnType<typeof createWorkflowsRunner>;
  clock: WorkflowsTestClock;
  runtime: WorkflowsTestRuntime;
  test: TestContext<SupportedAdapter>;
  createInstance: {
    <K extends keyof TRegistry & string>(
      workflowNameOrKey: K,
      options?: { id?: string; params?: WorkflowParamsFromEntry<TRegistry[K]> },
    ): Promise<string>;
    (workflowNameOrKey: string, options?: { id?: string; params?: unknown }): Promise<string>;
  };
  createBatch: {
    <K extends keyof TRegistry & string>(
      workflowNameOrKey: K,
      instances: { id: string; params?: WorkflowParamsFromEntry<TRegistry[K]> }[],
    ): Promise<
      { id: string; details: InstanceStatusWithOutput<WorkflowOutputFromEntry<TRegistry[K]>> }[]
    >;
    (
      workflowNameOrKey: string,
      instances: { id: string; params?: unknown }[],
    ): Promise<{ id: string; details: InstanceStatus }[]>;
  };
  sendEvent: {
    <K extends keyof TRegistry & string>(
      workflowNameOrKey: K,
      instanceId: string,
      options: { type: string; payload?: unknown },
    ): Promise<InstanceStatusWithOutput<WorkflowOutputFromEntry<TRegistry[K]>>>;
    (
      workflowNameOrKey: string,
      instanceId: string,
      options: { type: string; payload?: unknown },
    ): Promise<InstanceStatus>;
  };
  getStatus: {
    <K extends keyof TRegistry & string>(
      workflowNameOrKey: K,
      instanceId: string,
    ): Promise<InstanceStatusWithOutput<WorkflowOutputFromEntry<TRegistry[K]>>>;
    (workflowNameOrKey: string, instanceId: string): Promise<InstanceStatus>;
  };
  getHistory: (
    workflowNameOrKey: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: {
      runNumber?: number;
      pageSize?: number;
      stepsCursor?: string;
      eventsCursor?: string;
      logsCursor?: string;
      includeLogs?: boolean;
      logLevel?: "debug" | "info" | "warn" | "error";
      logCategory?: string;
      order?: "asc" | "desc";
    },
  ) => Promise<WorkflowsHistory>;
  tick: (options?: RunnerTickOptions) => Promise<number>;
  runUntilIdle: (options?: {
    tickOptions?: RunnerTickOptions;
    maxTicks?: number;
  }) => Promise<{ processed: number; ticks: number }>;
};

const createTestClock = (startAt?: Date | number): WorkflowsTestClock => {
  let currentMs =
    startAt instanceof Date
      ? startAt.getTime()
      : typeof startAt === "number"
        ? startAt
        : Date.now();

  return {
    now: () => new Date(currentMs),
    set: (timestamp) => {
      currentMs = timestamp instanceof Date ? timestamp.getTime() : timestamp;
      return new Date(currentMs);
    },
    advanceBy: (duration) => {
      currentMs += parseDurationMs(duration);
      return new Date(currentMs);
    },
  };
};

export const createWorkflowsTestRuntime = (options?: {
  startAt?: Date | number;
  seed?: number;
}): WorkflowsTestRuntime => {
  const time = createTestClock(options?.startAt);
  let state = options?.seed ?? 1;

  const nextFloat = () => {
    state = (state * 48271) % 0x7fffffff;
    return state / 0x7fffffff;
  };

  const nextHex = (length: number) => {
    let value = "";
    for (let i = 0; i < length; i += 1) {
      value += Math.floor(nextFloat() * 16).toString(16);
    }
    return value;
  };

  const uuid = () => {
    return [
      nextHex(8),
      nextHex(4),
      `4${nextHex(3)}`,
      `${(8 + Math.floor(nextFloat() * 4)).toString(16)}${nextHex(3)}`,
      nextHex(12),
    ].join("-");
  };

  const cuid = () => `cuid_${nextHex(8)}${nextHex(8)}`;

  return {
    time,
    random: {
      float: () => nextFloat(),
      uuid,
      cuid,
    },
  };
};

const resolveWorkflowName = (
  workflows: WorkflowsRegistry,
  workflowNameOrKey: (keyof WorkflowsRegistry & string) | string,
) => {
  const lookup = workflows[String(workflowNameOrKey)];
  return lookup?.name ?? String(workflowNameOrKey);
};

const assertJsonResponse = <T>(response: {
  type: string;
  data?: T;
  error?: { message: string; code: string };
}) => {
  if (response.type !== "json") {
    const errorDetails =
      response.type === "error"
        ? ` (${response.error?.code ?? "UNKNOWN"}: ${response.error?.message ?? "Unknown error"})`
        : "";
    throw new Error(`Expected json response, received ${response.type}${errorDetails}`);
  }
  return response.data as T;
};

export async function createWorkflowsTestHarness<TRegistry extends WorkflowsRegistry>(
  options: WorkflowsTestHarnessOptions<TRegistry>,
): Promise<WorkflowsTestHarness<TRegistry>> {
  const runtime =
    options.runtime ??
    createWorkflowsTestRuntime({ startAt: options.clockStartAt, seed: options.randomSeed });
  const clock = runtime.time;
  const workflows = options.workflows;
  let adapterConfig: SupportedAdapter = options.adapter;
  if (adapterConfig.type === "in-memory" || adapterConfig.type === "model-checker") {
    adapterConfig = {
      ...adapterConfig,
      options: {
        ...adapterConfig.options,
        clock: adapterConfig.options?.clock ?? runtime.time,
      },
    };
  }
  const config: WorkflowsFragmentConfig<TRegistry> = {
    workflows,
    runtime,
    ...options.fragmentConfig,
  };

  const { fragments, test } = await options.testBuilder
    .withTestAdapter(adapterConfig)
    .withFragment(
      "workflows",
      instantiate(workflowsFragmentDefinition)
        .withConfig(config)
        .withRoutes([workflowsRoutesFactory]),
    )
    .build();

  const { fragment, db } = fragments.workflows;
  const runner = createWorkflowsRunner({
    fragment,
    workflows,
    runtime,
    runnerId: options.runnerOptions?.runnerId,
    leaseMs: options.runnerOptions?.leaseMs,
  });
  if (options.autoTickHooks !== false) {
    config.runner = runner;
  }

  const createInstance = async (
    workflowNameOrKey: (keyof TRegistry & string) | string,
    instanceOptions?: { id?: string; params?: unknown },
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const response = await fragment.callRoute("POST", "/:workflowName/instances", {
      pathParams: { workflowName },
      body: instanceOptions ?? {},
    });
    const data = assertJsonResponse<{ id: string }>(response);
    return data.id;
  };

  const createBatch = async (
    workflowNameOrKey: (keyof TRegistry & string) | string,
    instances: { id: string; params?: unknown }[],
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const response = await fragment.callRoute("POST", "/:workflowName/instances/batch", {
      pathParams: { workflowName },
      body: { instances },
    });
    const data = assertJsonResponse<{ instances: { id: string; details: InstanceStatus }[] }>(
      response,
    );
    return data.instances;
  };

  const sendEvent = async (
    workflowNameOrKey: (keyof TRegistry & string) | string,
    instanceId: string,
    eventOptions: { type: string; payload?: unknown },
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const response = await fragment.callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/events",
      {
        pathParams: { workflowName, instanceId },
        body: eventOptions,
      },
    );
    const data = assertJsonResponse<{ status: InstanceStatus }>(response);
    return data.status;
  };

  const getStatus = async (
    workflowNameOrKey: (keyof TRegistry & string) | string,
    instanceId: string,
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const response = await fragment.callRoute("GET", "/:workflowName/instances/:instanceId", {
      pathParams: { workflowName, instanceId },
    });
    const data = assertJsonResponse<{ details: InstanceStatus }>(response);
    return data.details;
  };

  const getHistory = async (
    workflowNameOrKey: (keyof TRegistry & string) | string,
    instanceId: string,
    historyOptions?: {
      runNumber?: number;
      pageSize?: number;
      stepsCursor?: string;
      eventsCursor?: string;
      logsCursor?: string;
      includeLogs?: boolean;
      logLevel?: "debug" | "info" | "warn" | "error";
      logCategory?: string;
      order?: "asc" | "desc";
    },
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const query: Record<string, string> = {};
    if (historyOptions?.runNumber !== undefined) {
      query["runNumber"] = String(historyOptions.runNumber);
    }
    if (historyOptions?.pageSize !== undefined) {
      query["pageSize"] = String(historyOptions.pageSize);
    }
    if (historyOptions?.stepsCursor) {
      query["stepsCursor"] = historyOptions.stepsCursor;
    }
    if (historyOptions?.eventsCursor) {
      query["eventsCursor"] = historyOptions.eventsCursor;
    }
    if (historyOptions?.logsCursor) {
      query["logsCursor"] = historyOptions.logsCursor;
    }
    if (historyOptions?.includeLogs !== undefined) {
      query["includeLogs"] = historyOptions.includeLogs ? "true" : "false";
    }
    if (historyOptions?.logLevel) {
      query["logLevel"] = historyOptions.logLevel;
    }
    if (historyOptions?.logCategory) {
      query["logCategory"] = historyOptions.logCategory;
    }
    if (historyOptions?.order) {
      query["order"] = historyOptions.order;
    }
    const response = await fragment.callRoute(
      "GET",
      "/:workflowName/instances/:instanceId/history",
      {
        pathParams: { workflowName, instanceId },
        query,
      },
    );
    return assertJsonResponse<WorkflowsHistory>(response);
  };

  const tick = async (tickOptions?: RunnerTickOptions) => {
    return await runner.tick(tickOptions ?? {});
  };

  const runUntilIdle = async (runOptions?: {
    tickOptions?: RunnerTickOptions;
    maxTicks?: number;
  }) => {
    const maxTicks = runOptions?.maxTicks ?? 25;
    let ticks = 0;
    let processed = 0;

    while (ticks < maxTicks) {
      const result = await runner.tick(runOptions?.tickOptions ?? {});
      ticks += 1;
      processed += result;
      if (result === 0) {
        break;
      }
    }

    return { processed, ticks };
  };

  return {
    fragment,
    db,
    runner,
    clock,
    runtime,
    test,
    createInstance: createInstance as WorkflowsTestHarness<TRegistry>["createInstance"],
    createBatch: createBatch as WorkflowsTestHarness<TRegistry>["createBatch"],
    sendEvent: sendEvent as WorkflowsTestHarness<TRegistry>["sendEvent"],
    getStatus: getStatus as WorkflowsTestHarness<TRegistry>["getStatus"],
    getHistory,
    tick,
    runUntilIdle,
  };
}
