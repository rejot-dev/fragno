import {
  instantiate,
  type AnyFragnoInstantiatedFragment,
  type FragnoRuntime,
} from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import type {
  AnyFragmentResult,
  DatabaseFragmentsTestBuilder,
  SupportedAdapter,
  TestContext,
  TestDb,
} from "@fragno-dev/test";

import { workflowsFragmentDefinition } from "./definition";
export type { WorkflowStepLivePumpRegistry } from "./runner/step-live-pump";
import type { WorkflowsFragment, WorkflowsFragmentServices } from "./index";
import { runWorkflowsTick } from "./new-runner";
import { workflowsRoutesFactory } from "./routes";
import { parseDurationMs } from "./utils";
import type {
  InstanceStatus,
  InstanceStatusWithOutput,
  WorkflowDuration,
  WorkflowEnqueuedHookPayload,
  WorkflowOutputFromEntry,
  WorkflowParamsFromEntry,
  WorkflowRegistryEntry,
  WorkflowsFragmentConfig,
  WorkflowsRegistry,
} from "./workflow";

export type WorkflowsHistoryStep = {
  id: string;
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
  error?: { name: string; message: string };
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowsHistoryEvent = {
  id: string;
  type: string;
  payload: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

export type WorkflowsHistoryEmission = {
  id: string;
  stepKey: string;
  epoch: string;
  sequence: number;
  actor: string;
  payload: unknown | null;
  createdAt: Date;
};

export type WorkflowsHistory = {
  steps: WorkflowsHistoryStep[];
  events: WorkflowsHistoryEvent[];
  emissions: WorkflowsHistoryEmission[];
};

export type WorkflowsTestClock = {
  now: () => Date;
  set: (timestamp: Date | number) => Date;
  advanceBy: (duration: WorkflowDuration) => Date;
};

export type WorkflowsTestControlSnapshot =
  | { key: string; status: "resolved"; pendingCount: number; value: unknown }
  | { key: string; status: "rejected"; pendingCount: number; error: Error }
  | { key: string; status: "pending"; pendingCount: number };

export type WorkflowsTestControls = {
  wait: <T = unknown>(key: string) => Promise<T>;
  resolve: (key: string, value?: unknown) => void;
  reject: (key: string, error?: unknown) => void;
  get: (key: string) => WorkflowsTestControlSnapshot;
  reset: (key?: string) => void;
};

export type WorkflowsTestRuntime = FragnoRuntime & {
  time: WorkflowsTestClock;
  controls: WorkflowsTestControls;
};

export type WorkflowsTestHarnessFragment<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> =
  {
    fragment: WorkflowsFragment<TRegistry>;
    db: TestDb;
    services: WorkflowsFragmentServices<TRegistry>;
    deps: WorkflowsFragment<TRegistry>["$internal"]["deps"];
    callRoute: WorkflowsFragment<TRegistry>["callRoute"];
  };

type WorkflowsTestHarnessFragments<
  TRegistry extends WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult>,
> = TFragments & {
  workflows: WorkflowsTestHarnessFragment<TRegistry>;
};

export type WorkflowsTestHarnessOptions<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TConfiguredFragments extends Record<string, AnyFragmentResult> = TFragments,
> = {
  workflows: TRegistry;
  adapter: SupportedAdapter;
  /**
   * Builder returned by `buildDatabaseFragmentsTest()` from @fragno-dev/test.
   */
  testBuilder: DatabaseFragmentsTestBuilder<TFragments, SupportedAdapter | undefined>;
  configureBuilder?: (
    builder: DatabaseFragmentsTestBuilder<TFragments, SupportedAdapter>,
  ) => DatabaseFragmentsTestBuilder<TConfiguredFragments, SupportedAdapter>;
  clockStartAt?: Date | number;
  runtime?: WorkflowsTestRuntime;
  randomSeed?: number;
  autoTickHooks?: boolean;
  fragmentConfig?: Omit<WorkflowsFragmentConfig<TRegistry>, "workflows" | "runtime">;
  fragmentOptions?: FragnoPublicConfigWithDatabase;
};

export type WorkflowsTestRunner = {
  tick: (payload: WorkflowEnqueuedHookPayload) => Promise<number>;
  runUntilIdle: (
    payload: WorkflowEnqueuedHookPayload,
    options?: RunUntilIdleOptions,
  ) => Promise<{ processed: number; ticks: number }>;
  kill: () => Promise<void>;
  restart: () => Promise<void>;
  killAndRestart: () => Promise<void>;
};

export type WorkflowsTestHarness<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
> = {
  fragments: WorkflowsTestHarnessFragments<TRegistry, TFragments>;
  fragment: WorkflowsFragment<TRegistry>;
  db: TestDb;
  services: WorkflowsFragmentServices<TRegistry>;
  deps: WorkflowsFragment<TRegistry>["$internal"]["deps"];
  callRoute: WorkflowsFragment<TRegistry>["callRoute"];
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
      options: { type: string; payload?: unknown; createdAt?: Date },
    ): Promise<InstanceStatusWithOutput<WorkflowOutputFromEntry<TRegistry[K]>>>;
    (
      workflowNameOrKey: string,
      instanceId: string,
      options: { type: string; payload?: unknown; createdAt?: Date },
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
  ) => Promise<WorkflowsHistory>;
  tick: (payload: WorkflowEnqueuedHookPayload) => Promise<number>;
  runUntilIdle: (
    payload: WorkflowEnqueuedHookPayload,
    options?: RunUntilIdleOptions,
  ) => Promise<{ processed: number; ticks: number }>;
  createRunner: () => WorkflowsTestRunner;
  killRunner: () => Promise<void>;
  restartRunner: () => Promise<void>;
  killAndRestartRunner: () => Promise<void>;
};

export type RunUntilIdleOptions = {
  maxTicks?: number;
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

type PendingControlWaiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ControlEntry = {
  waiters: Set<PendingControlWaiter>;
  value?: unknown;
  error?: Error;
  status: "pending" | "resolved" | "rejected";
};

const toControlError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : "WORKFLOWS_TEST_CONTROL_REJECTED");
};

const createWorkflowsTestControls = (): WorkflowsTestControls => {
  const entries = new Map<string, ControlEntry>();

  const getOrCreateEntry = (key: string): ControlEntry => {
    const existing = entries.get(key);
    if (existing) {
      return existing;
    }
    const entry: ControlEntry = {
      waiters: new Set(),
      status: "pending",
    };
    entries.set(key, entry);
    return entry;
  };

  return {
    wait: <T = unknown>(key: string) => {
      const entry = getOrCreateEntry(key);
      if (entry.status === "resolved") {
        return Promise.resolve(entry.value as T);
      }
      if (entry.status === "rejected") {
        return Promise.reject(entry.error ?? new Error("WORKFLOWS_TEST_CONTROL_REJECTED"));
      }
      return new Promise<T>((resolve, reject) => {
        entry.waiters.add({
          resolve: (value) => resolve(value as T),
          reject,
        });
      });
    },
    resolve: (key, value) => {
      const entry = getOrCreateEntry(key);
      entry.status = "resolved";
      entry.value = value;
      entry.error = undefined;
      for (const waiter of entry.waiters) {
        waiter.resolve(value);
      }
      entry.waiters.clear();
    },
    reject: (key, error) => {
      const entry = getOrCreateEntry(key);
      const resolvedError = toControlError(error);
      entry.status = "rejected";
      entry.error = resolvedError;
      entry.value = undefined;
      for (const waiter of entry.waiters) {
        waiter.reject(resolvedError);
      }
      entry.waiters.clear();
    },
    get: (key) => {
      const entry = getOrCreateEntry(key);
      if (entry.status === "resolved") {
        return {
          key,
          status: "resolved",
          pendingCount: entry.waiters.size,
          value: entry.value,
        };
      }
      if (entry.status === "rejected") {
        return {
          key,
          status: "rejected",
          pendingCount: entry.waiters.size,
          error: entry.error ?? new Error("WORKFLOWS_TEST_CONTROL_REJECTED"),
        };
      }
      return {
        key,
        status: "pending",
        pendingCount: entry.waiters.size,
      };
    },
    reset: (key) => {
      if (key === undefined) {
        entries.clear();
        return;
      }
      entries.delete(key);
    },
  };
};

export const createWorkflowsTestRuntime = (options?: {
  startAt?: Date | number;
  seed?: number;
}): WorkflowsTestRuntime => {
  const time = createTestClock(options?.startAt);
  const controls = createWorkflowsTestControls();
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
    controls,
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
  data?: unknown;
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

export async function createWorkflowsTestHarness<
  TRegistry extends WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TConfiguredFragments extends Record<string, AnyFragmentResult> = TFragments,
>(
  options: WorkflowsTestHarnessOptions<TRegistry, TFragments, TConfiguredFragments>,
): Promise<WorkflowsTestHarness<TRegistry, TConfiguredFragments>> {
  const runtime =
    options.runtime ??
    createWorkflowsTestRuntime({ startAt: options.clockStartAt, seed: options.randomSeed });
  const clock = runtime.time;
  const workflows = options.workflows;
  let adapterConfig: SupportedAdapter = options.adapter;
  if (adapterConfig.type === "in-memory") {
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
    autoTickHooks: options.autoTickHooks,
    ...options.fragmentConfig,
  };
  const baseBuilder = options.testBuilder.withTestAdapter(adapterConfig);
  const configuredBuilder = options.configureBuilder
    ? options.configureBuilder(baseBuilder)
    : baseBuilder;
  const workflowsBuilder = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes([workflowsRoutesFactory]);
  const { fragments, test } = await configuredBuilder
    .withFragment(
      "workflows",
      options.fragmentOptions
        ? workflowsBuilder.withOptions(options.fragmentOptions)
        : workflowsBuilder,
    )
    .build();

  const fragmentsWithWorkflows = fragments as unknown as WorkflowsTestHarnessFragments<
    TRegistry,
    TConfiguredFragments
  >;
  const getWorkflowFragment = () => fragmentsWithWorkflows.workflows;
  const getFragment = () => getWorkflowFragment().fragment;
  const getDb = () => getWorkflowFragment().db;
  const callRoute: AnyFragnoInstantiatedFragment["callRoute"] = (...args) =>
    getWorkflowFragment().callRoute(...args);
  const workflowsByName = new Map<string, WorkflowRegistryEntry>();
  for (const entry of Object.values(workflows)) {
    workflowsByName.set(entry.name, entry);
  }

  const createInstance = async (
    workflowNameOrKey: (keyof TRegistry & string) | string,
    instanceOptions?: { id?: string; params?: unknown },
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const response = await callRoute("POST", "/:workflowName/instances", {
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
    const response = await callRoute("POST", "/:workflowName/instances/batch", {
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
    eventOptions: { type: string; payload?: unknown; createdAt?: Date },
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    if (eventOptions.createdAt !== undefined) {
      return await getFragment().inContext(async function () {
        const status = await this.handlerTx()
          .withServiceCalls(() => [
            getFragment().services.sendEvent(workflowName, instanceId, eventOptions),
          ])
          .transform(({ serviceResult: [result] }) => result)
          .execute();
        return status;
      });
    }
    const response = await callRoute("POST", "/:workflowName/instances/:instanceId/events", {
      pathParams: { workflowName, instanceId },
      body: { type: eventOptions.type, payload: eventOptions.payload },
    });
    const data = assertJsonResponse<{ status: InstanceStatus }>(response);
    return data.status;
  };

  const getStatus = async (
    workflowNameOrKey: (keyof TRegistry & string) | string,
    instanceId: string,
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const response = await callRoute("GET", "/:workflowName/instances/:instanceId", {
      pathParams: { workflowName, instanceId },
    });
    const data = assertJsonResponse<{ details: InstanceStatus }>(response);
    return data.details;
  };

  const getHistory = async (
    workflowNameOrKey: (keyof TRegistry & string) | string,
    instanceId: string,
  ) => {
    const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
    const response = await callRoute("GET", "/:workflowName/instances/:instanceId/history", {
      pathParams: { workflowName, instanceId },
    });
    return assertJsonResponse<WorkflowsHistory>(response);
  };

  const runTick = async (payload: WorkflowEnqueuedHookPayload) => {
    return await getFragment().inContext(function () {
      return runWorkflowsTick({
        handlerTx: this.handlerTx,
        busHandlerTx: this.handlerTx,
        workflows,
        workflowsByName,
        stepEmissions: config.stepEmissions,
        payload: { ...payload, timestamp: clock.now() },
      });
    });
  };

  const createRunner = (): WorkflowsTestRunner => {
    let isAlive = true;

    const tick = async (payload: WorkflowEnqueuedHookPayload) => {
      if (!isAlive) {
        return 0;
      }
      return await runTick(payload);
    };

    const runUntilIdle = async (
      payload: WorkflowEnqueuedHookPayload,
      options?: RunUntilIdleOptions,
    ) => {
      const maxTicks = options?.maxTicks ?? 25;

      let ticks = 0;
      let processed = 0;

      while (ticks < maxTicks) {
        const result = await tick(payload);
        ticks += 1;
        processed += result;
        if (result === 0) {
          break;
        }
      }

      return { processed, ticks };
    };

    return {
      tick,
      runUntilIdle,
      async kill() {
        isAlive = false;
      },
      async restart() {
        isAlive = true;
      },
      async killAndRestart() {
        isAlive = false;
        isAlive = true;
      },
    };
  };

  const defaultRunner = createRunner();
  const tick = defaultRunner.tick;
  const runUntilIdle = defaultRunner.runUntilIdle;

  return {
    fragments: fragmentsWithWorkflows,
    get fragment() {
      return getFragment();
    },
    get db() {
      return getDb();
    },
    get services() {
      return getFragment().services;
    },
    get deps() {
      return getFragment().$internal.deps;
    },
    get callRoute() {
      return getFragment().callRoute;
    },
    clock,
    runtime,
    test,
    createInstance: createInstance as WorkflowsTestHarness<
      TRegistry,
      TConfiguredFragments
    >["createInstance"],
    createBatch: createBatch as WorkflowsTestHarness<
      TRegistry,
      TConfiguredFragments
    >["createBatch"],
    sendEvent: sendEvent as WorkflowsTestHarness<TRegistry, TConfiguredFragments>["sendEvent"],
    getStatus: getStatus as WorkflowsTestHarness<TRegistry, TConfiguredFragments>["getStatus"],
    getHistory,
    tick,
    runUntilIdle,
    createRunner,
    async killRunner() {
      await defaultRunner.kill();
    },
    async restartRunner() {
      await (test as unknown as { recreateFragments: () => Promise<void> }).recreateFragments();
      await defaultRunner.restart();
    },
    async killAndRestartRunner() {
      await defaultRunner.kill();
      await (test as unknown as { recreateFragments: () => Promise<void> }).recreateFragments();
      await defaultRunner.restart();
    },
  };
}
