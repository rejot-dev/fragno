import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";
import type { AnySchema } from "@fragno-dev/db/schema";
import type { MutationOperation } from "@fragno-dev/db/unit-of-work";

import {
  instantiate,
  type FragnoRequestLifecycleContext,
  type FragnoRuntime,
} from "@fragno-dev/core";
import {
  createHandlerTxBuilder,
  InMemoryAdapter,
  type DatabaseHandlerTx,
  type FragnoPublicConfigWithDatabase,
  type IUnitOfWork,
} from "@fragno-dev/db";
import { drainDurableHooks } from "@fragno-dev/test";
import type {
  AdditionalFragmentRuntime,
  AnyFragmentResult,
  DatabaseFragmentsTestBuilder,
  SupportedAdapter,
  TestContext,
  TestDb,
} from "@fragno-dev/test";

import type { WorkflowsHistory } from "./definition";
import { workflowsFragmentDefinition } from "./definition";
export type {
  WorkflowsHistory,
  WorkflowsHistoryEmission,
  WorkflowsHistoryEvent,
  WorkflowsHistoryStep,
} from "./definition";
export type { WorkflowStepLivePumpRegistry } from "./runner/step-live-pump";
import type { WorkflowsFragment, WorkflowsFragmentServices } from "./index";
import { buildScopedInstanceRowId } from "./instance-ref";
import { runWorkflowsTick } from "./new-runner";
import { workflowsRoutesFactory } from "./routes";
import { applyOutcome, applyRunnerMutations, type RunnerTaskOutcome } from "./runner/plan-writes";
import { createRunnerState } from "./runner/state";
import { isRunnerStepSuspended, RunnerStep } from "./runner/step";
import type { WorkflowStepLivePump } from "./runner/step-live-pump";
import { workflowsSchema } from "./schema";
import { parseDurationMs } from "./utils";
import type {
  InstanceStatus,
  InstanceStatusWithOutput,
  WorkflowDuration,
  WorkflowEnqueuedHookPayload,
  WorkflowInstanceRetryOptions,
  WorkflowOutputFromEntry,
  WorkflowParamsFromEntry,
  WorkflowRegistryEntry,
  WorkflowsFragmentConfig,
  WorkflowsRegistry,
} from "./workflow";

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

type WorkflowsDatabaseTestContext<
  TFragments extends Record<string, AnyFragmentResult>,
  TRegistry extends WorkflowsRegistry,
> = TestContext<SupportedAdapter> & {
  createAdditionalRuntime: () => Promise<
    AdditionalFragmentRuntime<WorkflowsTestHarnessFragments<TRegistry, TFragments>>
  >;
  recreateFragments: () => Promise<void>;
  inContext: AdditionalFragmentRuntime<
    WorkflowsTestHarnessFragments<TRegistry, TFragments>
  >["inContext"];
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
  configureBuilderAfterWorkflows?: (
    builder: DatabaseFragmentsTestBuilder<
      TConfiguredFragments & { workflows: WorkflowsTestHarnessFragment<TRegistry> },
      SupportedAdapter
    >,
  ) => DatabaseFragmentsTestBuilder<
    TConfiguredFragments & { workflows: WorkflowsTestHarnessFragment<TRegistry> },
    SupportedAdapter
  >;
  clockStartAt?: Date | number;
  runtime?: WorkflowsTestRuntime;
  randomSeed?: number;
  autoTickHooks?: boolean;
  fragmentConfig?: Omit<WorkflowsFragmentConfig<TRegistry>, "workflows" | "runtime">;
  fragmentOptions?: FragnoPublicConfigWithDatabase;
};

export type WorkflowsTestRunPayload = Omit<WorkflowEnqueuedHookPayload, "instanceRef"> & {
  instanceRef?: string;
};

export type WorkflowsTestRunner<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
> = {
  tick: (payload: WorkflowsTestRunPayload) => Promise<number>;
  runUntilIdle: (
    payload: WorkflowsTestRunPayload,
    options?: RunUntilIdleOptions,
  ) => Promise<{ processed: number; ticks: number }>;
  callRoute: WorkflowsFragment<TRegistry>["callRoute"];
  getFragments: () => Promise<WorkflowsTestHarnessFragments<TRegistry, TFragments>>;
  inContext: {
    <TResult>(callback: (this: FragnoRequestLifecycleContext) => TResult): Promise<TResult>;
    <TResult>(
      callback: (this: FragnoRequestLifecycleContext) => Promise<TResult>,
    ): Promise<TResult>;
  };
  drainHooks: () => Promise<void>;
  restart: () => Promise<void>;
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
  test: WorkflowsDatabaseTestContext<TFragments, TRegistry>;
  createInstance: {
    <K extends keyof TRegistry & string>(
      workflowNameOrKey: K,
      options?: {
        id?: string;
        params?: WorkflowParamsFromEntry<TRegistry[K]>;
        remoteWorkflowName?: string;
      },
    ): Promise<string>;
    (
      workflowNameOrKey: string,
      options?: { id?: string; params?: unknown; remoteWorkflowName?: string },
    ): Promise<string>;
  };
  createBatch: {
    <K extends keyof TRegistry & string>(
      workflowNameOrKey: K,
      instances: { id: string; params?: WorkflowParamsFromEntry<TRegistry[K]> }[],
      options?: { remoteWorkflowName?: string },
    ): Promise<
      { id: string; details: InstanceStatusWithOutput<WorkflowOutputFromEntry<TRegistry[K]>> }[]
    >;
    (
      workflowNameOrKey: string,
      instances: { id: string; params?: unknown }[],
      options?: { remoteWorkflowName?: string },
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
  pauseInstance: {
    <K extends keyof TRegistry & string>(
      workflowNameOrKey: K,
      instanceId: string,
    ): Promise<InstanceStatusWithOutput<WorkflowOutputFromEntry<TRegistry[K]>>>;
    (workflowNameOrKey: string, instanceId: string): Promise<InstanceStatus>;
  };
  resumeInstance: {
    <K extends keyof TRegistry & string>(
      workflowNameOrKey: K,
      instanceId: string,
    ): Promise<InstanceStatusWithOutput<WorkflowOutputFromEntry<TRegistry[K]>>>;
    (workflowNameOrKey: string, instanceId: string): Promise<InstanceStatus>;
  };
  retryInstance: {
    <K extends keyof TRegistry & string>(
      workflowNameOrKey: K,
      instanceId: string,
      options?: WorkflowInstanceRetryOptions,
    ): Promise<InstanceStatusWithOutput<WorkflowOutputFromEntry<TRegistry[K]>>>;
    (
      workflowNameOrKey: string,
      instanceId: string,
      options?: WorkflowInstanceRetryOptions,
    ): Promise<InstanceStatus>;
  };
  terminateInstance: {
    <K extends keyof TRegistry & string>(
      workflowNameOrKey: K,
      instanceId: string,
    ): Promise<InstanceStatusWithOutput<WorkflowOutputFromEntry<TRegistry[K]>>>;
    (workflowNameOrKey: string, instanceId: string): Promise<InstanceStatus>;
  };
  tick: (payload: WorkflowsTestRunPayload) => Promise<number>;
  runUntilIdle: (
    payload: WorkflowsTestRunPayload,
    options?: RunUntilIdleOptions,
  ) => Promise<{ processed: number; ticks: number }>;
  createRunner: () => WorkflowsTestRunner<TRegistry, TFragments>;
  restart: () => Promise<void>;
};

export type RunUntilIdleOptions = {
  maxTicks?: number;
};

export type RecordedWorkflowStepRun = {
  mutations: MutationOperation<AnySchema>[];
  rows: {
    instance: Awaited<ReturnType<typeof readRecordedWorkflowRows>>["instance"];
    steps: Awaited<ReturnType<typeof readRecordedWorkflowRows>>["steps"];
    events: Awaited<ReturnType<typeof readRecordedWorkflowRows>>["events"];
    stepEmissions: Awaited<ReturnType<typeof readRecordedWorkflowRows>>["stepEmissions"];
  };
};

export type RecordWorkflowStepRunForTestOptions<TOutput = unknown> = {
  workflowName: string;
  instanceId: string;
  params?: unknown;
  remoteWorkflowName?: string | null;
  run: (step: RunnerStep) => Promise<TOutput> | TOutput;
  onMutations?: (args: {
    mutations: MutationOperation<AnySchema>[];
    allMutations: MutationOperation<AnySchema>[];
  }) => Promise<void> | void;
  stepEmissions?: BufferedPumpRegistry<WorkflowStepLivePump>;
  workflowsByName?: ReadonlyMap<string, WorkflowRegistryEntry>;
  createEpoch?: () => string;
  schemas?: readonly { schema: AnySchema; namespace: string | null }[];
};

const readRecordedWorkflowRows = async (
  handlerTx: DatabaseHandlerTx,
  workflowName: string,
  instanceId: string,
) =>
  await handlerTx()
    .retrieve(({ forSchema }) => {
      const uow = forSchema(workflowsSchema);
      const instanceRef = buildScopedInstanceRowId(workflowName, instanceId);
      return uow
        .findFirst("workflow_instance", (b) =>
          b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
            eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
          ),
        )
        .find("workflow_step", (b) =>
          b
            .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
              eb("instanceRef", "=", instanceRef),
            )
            .orderByIndex("idx_workflow_step_instanceRef_createdAt", "asc"),
        )
        .find("workflow_event", (b) =>
          b
            .whereIndex("idx_workflow_event_instanceRef_createdAt", (eb) =>
              eb("instanceRef", "=", instanceRef),
            )
            .orderByIndex("idx_workflow_event_instanceRef_createdAt", "asc"),
        )
        .find("workflow_step_emission", (b) =>
          b
            .whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
              eb("instanceRef", "=", instanceRef),
            )
            .orderByIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", "asc"),
        );
    })
    .transform(({ retrieveResult: [instance, steps, events, stepEmissions] }) => ({
      instance,
      steps,
      events,
      stepEmissions,
    }))
    .execute();

/**
 * Run one workflow step through the production runner transaction machinery and
 * return the UOW mutation operations it produced. This is intentionally a test
 * helper: durable hooks are no-oped, but step keys, step rows, outcome updates,
 * and live step emissions are created through the same runner code used in
 * production.
 */
export async function recordWorkflowStepRunForTest<TOutput = unknown>(
  options: RecordWorkflowStepRunForTestOptions<TOutput>,
): Promise<RecordedWorkflowStepRun> {
  const adapter = new InMemoryAdapter();
  adapter.registerSchema(workflowsSchema, null);
  for (const { schema, namespace } of options.schemas ?? []) {
    adapter.registerSchema(schema, namespace);
  }
  const mutations: MutationOperation<AnySchema>[] = [];
  const handlerTx: DatabaseHandlerTx = (txOptions) => {
    const onAfterMutate = txOptions?.onAfterMutate;
    return createHandlerTxBuilder({
      ...txOptions,
      createUnitOfWork: () => adapter.createBaseUnitOfWork(),
      onAfterMutate: async (uow) => {
        const newMutations = [...uow.getMutationOperations()];
        mutations.push(...newMutations);
        await options.onMutations?.({ mutations: newMutations, allMutations: mutations });
        await onAfterMutate?.(uow);
      },
    });
  };
  const instanceRef = buildScopedInstanceRowId(options.workflowName, options.instanceId);

  await handlerTx()
    .mutate(({ forSchema }) => {
      forSchema(workflowsSchema).create("workflow_instance", {
        id: instanceRef,
        workflowName: options.workflowName,
        remoteWorkflowName: options.remoteWorkflowName ?? null,
        instanceId: options.instanceId,
        status: "active",
        params: options.params ?? {},
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });
    })
    .execute();

  const initialRows = await readRecordedWorkflowRows(
    handlerTx,
    options.workflowName,
    options.instanceId,
  );
  if (!initialRows.instance) {
    throw new Error("RECORDED_WORKFLOW_INSTANCE_NOT_FOUND");
  }
  const instance = initialRows.instance;

  const state = createRunnerState(
    instance,
    initialRows.steps,
    initialRows.events,
    initialRows.stepEmissions,
  );
  let epoch = 0;
  const stepEmissions = options.stepEmissions ?? new BufferedPumpRegistry<WorkflowStepLivePump>();
  const step = new RunnerStep({
    state,
    taskKind: "run",
    workflowName: options.workflowName,
    instanceId: options.instanceId,
    handlerTx,
    createEpoch: options.createEpoch ?? (() => `test-epoch-${(epoch += 1)}`),
    stepEmissions,
    workflowsByName: new Map(options.workflowsByName ?? []),
  });

  let outcome: RunnerTaskOutcome;
  try {
    outcome = { type: "completed", output: await options.run(step) };
  } catch (error) {
    if (isRunnerStepSuspended(error)) {
      outcome = { type: "suspended", reason: error.reason };
    } else {
      outcome = {
        type: "errored",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  await handlerTx()
    .mutate((ctx) => {
      const uow = {
        forSchema: ctx.forSchema,
        idempotencyKey: ctx.idempotencyKey,
        triggerHook: () => undefined,
      } as unknown as IUnitOfWork;
      applyRunnerMutations(uow, state, new Map(options.workflowsByName ?? []));
      applyOutcome(uow, instance, outcome);
    })
    .execute();

  return {
    mutations: [...mutations],
    rows: await readRecordedWorkflowRows(handlerTx, options.workflowName, options.instanceId),
  };
}

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
  workflowNameOrKey: keyof WorkflowsRegistry,
) => {
  const lookup = workflows[workflowNameOrKey];
  return lookup?.name ?? workflowNameOrKey;
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
  const builderWithWorkflows = configuredBuilder.withFragment(
    "workflows",
    options.fragmentOptions
      ? workflowsBuilder.withOptions(options.fragmentOptions)
      : workflowsBuilder,
  );
  const finalBuilder = options.configureBuilderAfterWorkflows
    ? options.configureBuilderAfterWorkflows(builderWithWorkflows as never)
    : builderWithWorkflows;
  const { fragments, test: databaseTest } = await finalBuilder.build();

  const test = databaseTest as WorkflowsDatabaseTestContext<TConfiguredFragments, TRegistry>;
  const fragmentsWithWorkflows = fragments as unknown as WorkflowsTestHarnessFragments<
    TRegistry,
    TConfiguredFragments
  >;
  const getWorkflowFragment = () => fragmentsWithWorkflows.workflows;
  const getFragment = () => getWorkflowFragment().fragment;
  const getDb = () => getWorkflowFragment().db;
  const workflowsByName = new Map<string, WorkflowRegistryEntry>();
  for (const entry of Object.values(workflows)) {
    workflowsByName.set(entry.name, entry);
  }

  const runWorkflowService = async <T>(createServiceCall: () => unknown) =>
    await getFragment().inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [createServiceCall() as never])
        .transform(({ serviceResult: [result] }) => result as T)
        .execute();
    });

  type RunnerRuntime = Pick<
    AdditionalFragmentRuntime<WorkflowsTestHarnessFragments<TRegistry, TConfiguredFragments>>,
    "fragments" | "recreateFragments" | "inContext"
  >;

  const getWorkflowFragmentFromRuntime = (runnerRuntime: RunnerRuntime) =>
    runnerRuntime.fragments.workflows.fragment;

  const completePayload = (payload: WorkflowsTestRunPayload): WorkflowEnqueuedHookPayload => ({
    ...payload,
    instanceRef:
      payload.instanceRef ?? buildScopedInstanceRowId(payload.workflowName, payload.instanceId),
  });

  const runTick = async (
    runnerRuntime: RunnerRuntime,
    payload: WorkflowsTestRunPayload,
    stepEmissions: WorkflowsFragmentConfig<TRegistry>["stepEmissions"],
  ) => {
    const workflowFragment = getWorkflowFragmentFromRuntime(runnerRuntime);
    return await workflowFragment.inContext(function () {
      const handlerTx = ((...args: Parameters<DatabaseHandlerTx>) =>
        workflowFragment.inContext(function (this: { handlerTx: DatabaseHandlerTx }) {
          return this.handlerTx(...args);
        })) as DatabaseHandlerTx;

      return runWorkflowsTick({
        handlerTx,
        busHandlerTx: handlerTx,
        workflows,
        workflowsByName,
        stepEmissions,
        payload: { ...completePayload(payload), timestamp: clock.now() },
      });
    });
  };

  const mainRunnerRuntime: RunnerRuntime = {
    fragments: fragmentsWithWorkflows,
    recreateFragments: test.recreateFragments,
    inContext: test.inContext,
  };

  const createRunner = (
    initialRuntime?: RunnerRuntime,
  ): WorkflowsTestRunner<TRegistry, TConfiguredFragments> => {
    let runtimePromise: Promise<RunnerRuntime> | undefined = initialRuntime
      ? Promise.resolve(initialRuntime)
      : undefined;

    const getRunnerRuntime = () => {
      runtimePromise ??= test.createAdditionalRuntime();
      return runtimePromise;
    };

    const getWorkflowResult = async () => (await getRunnerRuntime()).fragments.workflows;

    const tick = async (payload: WorkflowsTestRunPayload) => {
      const runnerRuntime = await getRunnerRuntime();
      return await runTick(
        runnerRuntime,
        payload,
        runnerRuntime.fragments.workflows.fragment.$internal.deps.stepEmissions,
      );
    };

    const runUntilIdle = async (
      payload: WorkflowsTestRunPayload,
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
      async callRoute(...args) {
        return await (await getWorkflowResult()).callRoute(...args);
      },
      async getFragments() {
        return (await getRunnerRuntime()).fragments;
      },
      async inContext(callback) {
        return await (await getRunnerRuntime()).inContext(callback as never);
      },
      async drainHooks() {
        const runnerRuntime = await getRunnerRuntime();
        await drainDurableHooks(
          Object.values(runnerRuntime.fragments).map((result) => result.fragment),
        );
      },
      async restart() {
        await (await getRunnerRuntime()).recreateFragments();
      },
    };
  };

  const defaultRunner = createRunner(mainRunnerRuntime);
  const tick = async (payload: WorkflowsTestRunPayload) =>
    await runTick(mainRunnerRuntime, payload, config.stepEmissions);
  const runUntilIdle = async (payload: WorkflowsTestRunPayload, options?: RunUntilIdleOptions) => {
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
      const fragment = getFragment();
      return fragment.callRoute.bind(fragment);
    },
    clock,
    runtime,
    test,
    createInstance: (async (
      workflowNameOrKey: (keyof TRegistry & string) | string,
      instanceOptions?: { id?: string; params?: unknown; remoteWorkflowName?: string },
    ) => {
      const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
      const result = await runWorkflowService<{ id: string }>(() =>
        getFragment().services.createInstance(workflowName, instanceOptions),
      );
      return result.id;
    }) as WorkflowsTestHarness<TRegistry, TConfiguredFragments>["createInstance"],
    createBatch: (async (
      workflowNameOrKey: (keyof TRegistry & string) | string,
      instances: { id: string; params?: unknown }[],
      options?: { remoteWorkflowName?: string },
    ) => {
      const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
      return await runWorkflowService<{ id: string; details: InstanceStatus }[]>(() =>
        getFragment().services.createBatch(workflowName, instances, options),
      );
    }) as WorkflowsTestHarness<TRegistry, TConfiguredFragments>["createBatch"],
    sendEvent: (async (
      workflowNameOrKey: (keyof TRegistry & string) | string,
      instanceId: string,
      eventOptions: { type: string; payload?: unknown; createdAt?: Date },
    ) => {
      const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
      return await runWorkflowService<InstanceStatus>(() =>
        getFragment().services.sendEvent(workflowName, instanceId, eventOptions),
      );
    }) as WorkflowsTestHarness<TRegistry, TConfiguredFragments>["sendEvent"],
    getStatus: (async (
      workflowNameOrKey: (keyof TRegistry & string) | string,
      instanceId: string,
    ) => {
      const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
      return await runWorkflowService<InstanceStatus>(() =>
        getFragment().services.getInstanceStatus(workflowName, instanceId),
      );
    }) as WorkflowsTestHarness<TRegistry, TConfiguredFragments>["getStatus"],
    async getHistory(workflowNameOrKey: (keyof TRegistry & string) | string, instanceId: string) {
      const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
      return await runWorkflowService<WorkflowsHistory>(() =>
        getFragment().services.listHistory({ workflowName, instanceId }),
      );
    },
    pauseInstance: (async (
      workflowNameOrKey: (keyof TRegistry & string) | string,
      instanceId: string,
    ) => {
      const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
      return await runWorkflowService<InstanceStatus>(() =>
        getFragment().services.pauseInstance(workflowName, instanceId),
      );
    }) as WorkflowsTestHarness<TRegistry, TConfiguredFragments>["pauseInstance"],
    resumeInstance: (async (
      workflowNameOrKey: (keyof TRegistry & string) | string,
      instanceId: string,
    ) => {
      const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
      return await runWorkflowService<InstanceStatus>(() =>
        getFragment().services.resumeInstance(workflowName, instanceId),
      );
    }) as WorkflowsTestHarness<TRegistry, TConfiguredFragments>["resumeInstance"],
    retryInstance: (async (
      workflowNameOrKey: (keyof TRegistry & string) | string,
      instanceId: string,
      options?: WorkflowInstanceRetryOptions,
    ) => {
      const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
      const result = await runWorkflowService<{ instance: { details: InstanceStatus } }>(() =>
        getFragment().services.retryInstance(workflowName, instanceId, options),
      );
      return result.instance.details;
    }) as WorkflowsTestHarness<TRegistry, TConfiguredFragments>["retryInstance"],
    terminateInstance: (async (
      workflowNameOrKey: (keyof TRegistry & string) | string,
      instanceId: string,
    ) => {
      const workflowName = resolveWorkflowName(workflows, workflowNameOrKey);
      return await runWorkflowService<InstanceStatus>(() =>
        getFragment().services.terminateInstance(workflowName, instanceId),
      );
    }) as WorkflowsTestHarness<TRegistry, TConfiguredFragments>["terminateInstance"],
    tick,
    runUntilIdle,
    createRunner,
    async restart() {
      await defaultRunner.restart();
    },
  };
}
