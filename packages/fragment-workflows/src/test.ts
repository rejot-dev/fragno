import { instantiate, type AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import {
  buildDatabaseFragmentsTest,
  type SupportedAdapter,
  type TestContext,
} from "@fragno-dev/test";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import { createWorkflowsRunner } from "./runner";
import type {
  InstanceStatus,
  RunnerTickOptions,
  WorkflowDuration,
  WorkflowsClock,
  WorkflowsDispatcher,
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
  isReplay: boolean;
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

export type WorkflowsTestClock = WorkflowsClock & {
  set: (timestamp: Date | number) => Date;
  advanceBy: (duration: WorkflowDuration) => Date;
};

export type WorkflowsTestHarnessOptions = {
  workflows: WorkflowsRegistry;
  adapter: SupportedAdapter;
  dispatcher?: WorkflowsDispatcher;
  clock?: WorkflowsTestClock;
  clockStartAt?: Date | number;
  fragmentConfig?: Omit<
    WorkflowsFragmentConfig,
    "workflows" | "dispatcher" | "runner" | "enableRunnerTick" | "clock"
  >;
  runnerOptions?: {
    runnerId?: string;
    leaseMs?: number;
  };
};

export type WorkflowsTestHarness = {
  fragment: AnyFragnoInstantiatedFragment;
  db: SimpleQueryInterface<typeof workflowsSchema>;
  runner: ReturnType<typeof createWorkflowsRunner>;
  clock: WorkflowsTestClock;
  test: TestContext<SupportedAdapter>;
  createInstance: (
    workflowNameOrKey: keyof WorkflowsRegistry | string,
    options?: { id?: string; params?: unknown },
  ) => Promise<string>;
  createBatch: (
    workflowNameOrKey: keyof WorkflowsRegistry | string,
    instances: { id: string; params?: unknown }[],
  ) => Promise<{ id: string; details: InstanceStatus }[]>;
  sendEvent: (
    workflowNameOrKey: keyof WorkflowsRegistry | string,
    instanceId: string,
    options: { type: string; payload?: unknown },
  ) => Promise<InstanceStatus>;
  getStatus: (
    workflowNameOrKey: keyof WorkflowsRegistry | string,
    instanceId: string,
  ) => Promise<InstanceStatus>;
  getHistory: (
    workflowNameOrKey: keyof WorkflowsRegistry | string,
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

export const createWorkflowsTestClock = (startAt?: Date | number): WorkflowsTestClock => {
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

const resolveWorkflowName = (
  workflows: WorkflowsRegistry,
  workflowNameOrKey: keyof WorkflowsRegistry | string,
) => {
  const lookup = workflows[String(workflowNameOrKey)];
  return lookup?.name ?? String(workflowNameOrKey);
};

const assertJsonResponse = <T>(response: { type: string; data?: T }) => {
  if (response.type !== "json") {
    throw new Error("Expected json response");
  }
  return response.data as T;
};

export async function createWorkflowsTestHarness(
  options: WorkflowsTestHarnessOptions,
): Promise<WorkflowsTestHarness> {
  const clock = options.clock ?? createWorkflowsTestClock(options.clockStartAt);
  const dispatcher = options.dispatcher ?? { wake: () => {} };
  const workflows = options.workflows;

  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter(options.adapter)
    .withFragment(
      "workflows",
      instantiate(workflowsFragmentDefinition)
        .withConfig({
          workflows,
          dispatcher,
          clock,
          ...options.fragmentConfig,
        })
        .withRoutes([workflowsRoutesFactory]),
    )
    .build();

  const { fragment, db } = fragments.workflows;
  const runner = createWorkflowsRunner({
    db,
    workflows,
    clock,
    runnerId: options.runnerOptions?.runnerId,
    leaseMs: options.runnerOptions?.leaseMs,
  });

  const createInstance = async (
    workflowNameOrKey: keyof WorkflowsRegistry | string,
    instanceOptions?: { id?: string; params?: unknown },
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const response = await fragment.callRoute("POST", "/workflows/:workflowName/instances", {
      pathParams: { workflowName },
      body: instanceOptions ?? {},
    });
    const data = assertJsonResponse<{ id: string }>(response);
    return data.id;
  };

  const createBatch = async (
    workflowNameOrKey: keyof WorkflowsRegistry | string,
    instances: { id: string; params?: unknown }[],
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const response = await fragment.callRoute("POST", "/workflows/:workflowName/instances/batch", {
      pathParams: { workflowName },
      body: { instances },
    });
    const data = assertJsonResponse<{ instances: { id: string; details: InstanceStatus }[] }>(
      response,
    );
    return data.instances;
  };

  const sendEvent = async (
    workflowNameOrKey: keyof WorkflowsRegistry | string,
    instanceId: string,
    eventOptions: { type: string; payload?: unknown },
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const response = await fragment.callRoute(
      "POST",
      "/workflows/:workflowName/instances/:instanceId/events",
      {
        pathParams: { workflowName, instanceId },
        body: eventOptions,
      },
    );
    const data = assertJsonResponse<{ status: InstanceStatus }>(response);
    return data.status;
  };

  const getStatus = async (
    workflowNameOrKey: keyof WorkflowsRegistry | string,
    instanceId: string,
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const response = await fragment.callRoute(
      "GET",
      "/workflows/:workflowName/instances/:instanceId",
      {
        pathParams: { workflowName, instanceId },
      },
    );
    const data = assertJsonResponse<{ details: InstanceStatus }>(response);
    return data.details;
  };

  const getHistory = async (
    workflowNameOrKey: keyof WorkflowsRegistry | string,
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
      "/workflows/:workflowName/instances/:instanceId/history",
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
    test,
    createInstance,
    createBatch,
    sendEvent,
    getStatus,
    getHistory,
    tick,
    runUntilIdle,
  };
}
