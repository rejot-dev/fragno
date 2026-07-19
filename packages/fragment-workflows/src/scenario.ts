import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

import type {
  AnyFragnoInstantiatedFragment,
  FragmentDefinition,
  FragnoInstantiatedFragment,
} from "@fragno-dev/core";
import {
  getDurableHooksService,
  getInternalFragment,
  type AnyFragnoInstantiatedDatabaseFragment,
} from "@fragno-dev/db";
import { InMemoryLofiAdapter, createLofiRuntime, type LofiRuntime } from "@fragno-dev/lofi";
import {
  buildDatabaseFragmentsTest,
  createFragmentTestClientConfig,
  waitForStore,
  type AnyFragmentResult,
  type DatabaseFragmentsTestBuilder,
  type FragmentTestClientConfigOptions,
  type SupportedAdapter,
  type SubscribableStore,
  type TestDb,
} from "@fragno-dev/test";

import { createWorkflowStepLivePump, workflowStepLivePumpKey } from "./runner/step-live-pump";
import { workflowsSchema } from "./schema";
import type { WorkflowEventActor } from "./system-events";
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
  | ((
      ctx: WorkflowScenarioContext<TRegistry, TVars, Record<string, AnyFragmentResult>, unknown>,
    ) => T | Promise<T>);

type WorkflowScenarioFragmentConfiguratorHarness<
  TRegistry extends WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
> = Pick<
  WorkflowsTestHarness<TRegistry, TFragments>,
  "fragments" | "fragment" | "db" | "services" | "deps" | "callRoute"
>;

type WorkflowScenarioFragmentConfigurator<TRegistry extends WorkflowsRegistry> = {
  bivarianceHack(
    harness: WorkflowScenarioFragmentConfiguratorHarness<TRegistry>,
  ): Record<string, WorkflowScenarioFragmentBuilder>;
}["bivarianceHack"];

export type WorkflowScenarioHarnessOptions<TRegistry extends WorkflowsRegistry> = Omit<
  WorkflowsTestHarnessOptions<TRegistry>,
  "workflows" | "adapter" | "testBuilder"
> & {
  adapter?: SupportedAdapter;
  testBuilder?: DatabaseFragmentsTestBuilder<{}>;
  /**
   * Register fragments that depend on the workflows fragment. The returned builders are registered
   * with @fragno-dev/test, so additional runtimes recreate them normally.
   */
  configureFragments?: WorkflowScenarioFragmentConfigurator<TRegistry>;
};

type WorkflowScenarioFragmentBuilder = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definition: FragmentDefinition<any, any, any, any, any, any, any, any, any, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withOptions?: (options: any) => WorkflowScenarioFragmentBuilder;
  build: () => AnyFragnoInstantiatedFragment;
};

export type WorkflowScenarioFragmentInput =
  | AnyFragnoInstantiatedFragment
  | WorkflowScenarioFragmentBuilder;

type BuiltScenarioFragment<TFragment extends WorkflowScenarioFragmentInput> = TFragment extends {
  build: () => infer TBuilt;
}
  ? TBuilt
  : TFragment;

export type WorkflowScenarioFragmentResult<TFragment> =
  TFragment extends FragnoInstantiatedFragment<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    infer TDeps,
    infer TServices,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >
    ? {
        fragment: TFragment;
        services: TServices;
        deps: TDeps;
        callRoute: TFragment["callRoute"];
        db: TestDb;
      }
    : AnyFragmentResult;

export type WorkflowScenarioFragmentResults<
  TFragments extends Record<string, WorkflowScenarioFragmentInput>,
> = {
  [K in keyof TFragments]: WorkflowScenarioFragmentResult<BuiltScenarioFragment<TFragments[K]>>;
};

type WorkflowScenarioRuntimeFragments<
  TRegistry extends WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult>,
> = WorkflowsTestHarness<TRegistry, TFragments>["fragments"];

type WorkflowScenarioRunnerName<TRunners extends readonly string[] | undefined> =
  TRunners extends readonly string[] ? TRunners[number] : "scenario";

export type WorkflowScenarioClientConfigOptions<TRunnerName extends string = string> =
  FragmentTestClientConfigOptions & {
    runner?: TRunnerName;
  };

export type WorkflowScenarioClientConfig<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TRunnerName extends string = string,
> = <K extends keyof WorkflowScenarioRuntimeFragments<TRegistry, TFragments> & string>(
  fragmentName: K,
  options?: WorkflowScenarioClientConfigOptions<TRunnerName>,
) => FragnoPublicClientConfig;

export type WorkflowScenarioClientsFactoryContext<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TRunnerName extends string = string,
> = {
  fragments: WorkflowScenarioRuntimeFragments<TRegistry, TFragments>;
  createFragmentTestClientConfig: typeof createFragmentTestClientConfig;
  clientConfig: WorkflowScenarioClientConfig<TRegistry, TFragments, TRunnerName>;
};

export type WorkflowScenarioClientsFactory<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
  TRunnerName extends string = string,
> = (
  context: WorkflowScenarioClientsFactoryContext<TRegistry, TFragments, TRunnerName>,
) => TClients;

export type WorkflowScenarioClientRuntime<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
> = {
  fragments: WorkflowScenarioRuntimeFragments<TRegistry, TFragments>;
  clients: TClients;
  recreateFragments: () => Promise<void>;
};

type WorkflowScenarioStoreFactory<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
  TStore extends SubscribableStore<unknown> = SubscribableStore<unknown>,
> = (ctx: WorkflowScenarioContext<TRegistry, TVars, TFragments, TClients>) => TStore;

type WorkflowScenarioStoreDefinitions<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
> = Record<string, WorkflowScenarioStoreFactory<TRegistry, TVars, TFragments, TClients>>;

export type WorkflowScenarioStoresFactoryContext<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TVars extends WorkflowScenarioVars = WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
> = {
  fragments: WorkflowScenarioRuntimeFragments<TRegistry, TFragments>;
  clients: TClients;
  lofi: LofiRuntime;
  store: <TStore extends SubscribableStore<unknown>>(
    factory: WorkflowScenarioStoreFactory<TRegistry, TVars, TFragments, TClients, TStore>,
  ) => WorkflowScenarioStoreFactory<TRegistry, TVars, TFragments, TClients, TStore>;
};

export type WorkflowScenarioStoresFactory<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TVars extends WorkflowScenarioVars = WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
  TStores extends WorkflowScenarioStoreDefinitions<TRegistry, TVars, TFragments, TClients> =
    WorkflowScenarioStoreDefinitions<TRegistry, TVars, TFragments, TClients>,
> = (
  context: WorkflowScenarioStoresFactoryContext<TRegistry, TVars, TFragments, TClients>,
) => TStores & WorkflowScenarioStoreDefinitions<TRegistry, TVars, TFragments, TClients>;

type WorkflowScenarioStoreValue<TStore> =
  TStore extends SubscribableStore<infer TValue> ? TValue : never;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkflowScenarioStoreFromFactory<TFactory> = TFactory extends (...args: any[]) => infer TStore
  ? TStore
  : never;

export type WorkflowScenarioDefinition<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TVars extends WorkflowScenarioVars = WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
  TRunners extends readonly string[] | undefined = undefined,
  TStores extends WorkflowScenarioStoreDefinitions<TRegistry, TVars, TFragments, TClients> = Record<
    string,
    never
  >,
> = {
  name: string;
  workflows: TRegistry;
  runners?: TRunners;
  vars?: () => TVars;
  harness?: WorkflowScenarioHarnessOptions<TRegistry>;
  clients?: WorkflowScenarioClientsFactory<
    TRegistry,
    TFragments,
    TClients,
    WorkflowScenarioRunnerName<TRunners>
  >;
  stores?: WorkflowScenarioStoresFactory<TRegistry, TVars, TFragments, TClients, TStores>;
  steps: WorkflowScenarioStepsInput<TRegistry, TVars, TFragments, TClients, TRunners, TStores>;
};

type WorkflowScenarioFragmentsForConfigurator<TConfigureFragments> =
  TConfigureFragments extends WorkflowScenarioFragmentConfigurator<WorkflowsRegistry>
    ? WorkflowScenarioFragmentResults<ReturnType<TConfigureFragments>>
    : Record<string, AnyFragmentResult>;

type WorkflowScenarioInferredHarnessOptions<
  TRegistry extends WorkflowsRegistry,
  TConfigureFragments extends WorkflowScenarioFragmentConfigurator<TRegistry> | undefined,
> = Omit<WorkflowScenarioHarnessOptions<TRegistry>, "configureFragments"> & {
  configureFragments?: TConfigureFragments;
};

type WorkflowScenarioWorkflowStepBuilder<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
> = ReturnType<typeof createScenarioWorkflowSteps<TRegistry, TVars, TFragments, TClients>>;

type WorkflowScenarioRunnerStepBuilder<
  TRunnerName extends string,
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
> = ReturnType<typeof createScenarioRunnerSteps<TRunnerName, TRegistry, TVars, TFragments>>;

type WorkflowScenarioHookStepBuilder<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
> = ReturnType<typeof createScenarioHookSteps<TRegistry, TVars, TFragments, TClients>>;

type WorkflowScenarioStoreWaitForOptions<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
  TValue,
> = {
  storeAs?: (keyof TVars & string) | undefined;
  select?: (value: TValue) => unknown;
  assert?: (
    value: WorkflowScenarioReadonlyValue<TValue>,
    ctx: WorkflowScenarioReadonlyContext<TRegistry, TVars, TFragments, TClients>,
  ) => void | Promise<void>;
};

type WorkflowScenarioStoreHandle<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
  TStore extends SubscribableStore<unknown>,
> = {
  waitFor: (
    predicate: (value: WorkflowScenarioStoreValue<TStore>) => boolean,
    options?: WorkflowScenarioStoreWaitForOptions<
      TRegistry,
      TVars,
      TFragments,
      TClients,
      WorkflowScenarioStoreValue<TStore>
    >,
  ) => WorkflowScenarioWaitForStoreStep<
    TRegistry,
    TVars,
    TFragments,
    TClients,
    WorkflowScenarioStoreValue<TStore>
  >;
  read: <TValue>(
    read: (
      store: TStore,
      ctx: WorkflowScenarioContext<TRegistry, TVars, TFragments, TClients>,
    ) => TValue | Promise<TValue>,
    options?: { storeAs?: (keyof TVars & string) | undefined },
  ) => WorkflowScenarioReadStoreStep<TRegistry, TVars, TFragments, TClients, TStore, TValue>;
};

type WorkflowScenarioStoreHandles<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
  TStores extends WorkflowScenarioStoreDefinitions<TRegistry, TVars, TFragments, TClients>,
> = {
  [K in keyof TStores]: WorkflowScenarioStoreHandle<
    TRegistry,
    TVars,
    TFragments,
    TClients,
    WorkflowScenarioStoreFromFactory<TStores[K]>
  >;
};

type WorkflowScenarioDefaultStepsContext<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
  TStores extends WorkflowScenarioStoreDefinitions<TRegistry, TVars, TFragments, TClients>,
> = {
  workflow: WorkflowScenarioWorkflowStepBuilder<TRegistry, TVars, TFragments, TClients>;
  hooks: WorkflowScenarioHookStepBuilder<TRegistry, TVars, TFragments, TClients>;
  runner: WorkflowScenarioRunnerStepBuilder<"scenario", TRegistry, TVars, TFragments>;
  clients: TClients;
  stores: WorkflowScenarioStoreHandles<TRegistry, TVars, TFragments, TClients, TStores>;
  lofi: LofiRuntime;
};

type WorkflowScenarioNamedStepsContext<
  TRunnerName extends string,
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
  TStores extends WorkflowScenarioStoreDefinitions<TRegistry, TVars, TFragments, TClients>,
> = {
  workflow: WorkflowScenarioWorkflowStepBuilder<TRegistry, TVars, TFragments, TClients>;
  hooks: WorkflowScenarioHookStepBuilder<TRegistry, TVars, TFragments, TClients>;
  clients: TClients;
  stores: WorkflowScenarioStoreHandles<TRegistry, TVars, TFragments, TClients, TStores>;
  lofi: LofiRuntime;
  runners: {
    [K in TRunnerName]: WorkflowScenarioRunnerStepBuilder<K, TRegistry, TVars, TFragments>;
  };
  concurrent: (
    branches: Partial<
      Record<TRunnerName, WorkflowScenarioStep<TRegistry, TVars, TFragments, TClients>[]>
    >,
  ) => WorkflowScenarioConcurrentStep<TRunnerName, TRegistry, TVars, TFragments, TClients>;
};

type WorkflowScenarioStepsInput<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
  TRunners extends readonly string[] | undefined,
  TStores extends WorkflowScenarioStoreDefinitions<TRegistry, TVars, TFragments, TClients>,
> = (
  steps: TRunners extends readonly string[]
    ? WorkflowScenarioNamedStepsContext<
        TRunners[number],
        TRegistry,
        TVars,
        TFragments,
        TClients,
        TStores
      >
    : WorkflowScenarioDefaultStepsContext<TRegistry, TVars, TFragments, TClients, TStores>,
) => WorkflowScenarioStep<TRegistry, TVars, TFragments, TClients>[];

export type WorkflowScenarioDefinitionInput<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TVars extends WorkflowScenarioVars = WorkflowScenarioVars,
  TConfigureFragments extends WorkflowScenarioFragmentConfigurator<TRegistry> | undefined =
    | WorkflowScenarioFragmentConfigurator<TRegistry>
    | undefined,
  TClients = Record<string, never>,
  TRunners extends readonly string[] | undefined = undefined,
  TStores extends WorkflowScenarioStoreDefinitions<
    TRegistry,
    TVars,
    WorkflowScenarioFragmentsForConfigurator<TConfigureFragments>,
    TClients
  > = Record<string, never>,
> = {
  name: string;
  workflows: TRegistry;
  runners?: TRunners;
  vars?: () => TVars;
  harness?: WorkflowScenarioInferredHarnessOptions<TRegistry, TConfigureFragments>;
  clients?: WorkflowScenarioClientsFactory<
    TRegistry,
    WorkflowScenarioFragmentsForConfigurator<TConfigureFragments>,
    TClients,
    WorkflowScenarioRunnerName<TRunners>
  >;
  stores?: WorkflowScenarioStoresFactory<
    TRegistry,
    TVars,
    WorkflowScenarioFragmentsForConfigurator<TConfigureFragments>,
    TClients,
    TStores
  >;
  steps: WorkflowScenarioStepsInput<
    TRegistry,
    TVars,
    WorkflowScenarioFragmentsForConfigurator<TConfigureFragments>,
    TClients,
    TRunners,
    TStores
  >;
};

export type WorkflowScenarioGetHooksOptions<
  TRegistry extends WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult>,
  TPayload = unknown,
> = {
  fragment: keyof WorkflowScenarioRuntimeFragments<TRegistry, TFragments> & string;
  hookName?: string;
  status?: WorkflowScenarioHookRow["status"];
  where?: (record: Readonly<WorkflowScenarioHookRow<TPayload>>) => boolean;
};

export type WorkflowScenarioHooks<
  TRegistry extends WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult>,
> = {
  get: <TPayload = unknown>(
    options: WorkflowScenarioGetHooksOptions<TRegistry, TFragments, TPayload>,
  ) => Promise<WorkflowScenarioHookRow<TPayload>[]>;
};

export type WorkflowScenarioContext<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TVars extends WorkflowScenarioVars = WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
> = {
  name: string;
  harness: WorkflowsTestHarness<TRegistry, TFragments>;
  runtime: WorkflowsTestRuntime;
  clock: WorkflowsTestClock;
  vars: Partial<TVars>;
  state: WorkflowScenarioState<TRegistry>;
  hooks: WorkflowScenarioHooks<TRegistry, TFragments>;
  clients: TClients;
  lofi: LofiRuntime;
  createClientRuntime: () => Promise<
    WorkflowScenarioClientRuntime<TRegistry, TFragments, TClients>
  >;
  mountStore: <TStore extends SubscribableStore<unknown>>(store: TStore) => TStore;
  waitForStore: typeof waitForStore;
  cleanup: () => Promise<void>;
};

export type WorkflowScenarioReadonlyContext<
  TRegistry extends WorkflowsRegistry = WorkflowsRegistry,
  TVars extends WorkflowScenarioVars = WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
> = Omit<WorkflowScenarioContext<TRegistry, TVars, TFragments, TClients>, "vars"> & {
  readonly vars: Readonly<Partial<TVars>>;
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
  output: unknown;
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
  result: unknown;
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
  payload: unknown;
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
  actor: WorkflowEventActor;
  payload: unknown;
  createdAt: Date;
};

export type WorkflowScenarioObservedEmission<TPayload = unknown> = {
  workflowName: string;
  instanceId: string;
  stepKey: string;
  epoch: string;
  id: string;
  sequence: number;
  actor: WorkflowEventActor;
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
    options?: { order?: "asc" | "desc"; actor?: WorkflowEventActor; stepKey?: string },
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

export type WorkflowScenarioHookRow<TPayload = unknown> = {
  id: bigint;
  namespace: string;
  hookName: string;
  payload: TPayload;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
  error: string | null;
  createdAt: Date;
  nonce: string;
};

export type WorkflowScenarioReadHooksOptions<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
  TPayload = unknown,
> = WorkflowScenarioGetHooksOptions<TRegistry, TFragments, TPayload> & {
  storeAs?: (keyof TVars & string) | undefined;
  assert?: WorkflowScenarioReadAssert<
    TRegistry,
    TVars,
    TFragments,
    TClients,
    WorkflowScenarioHookRow<TPayload>[]
  >;
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
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
> =
  | WorkflowScenarioCreateStep<TRegistry, TVars>
  | WorkflowScenarioInitializeAndRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioCreateBatchStep<TRegistry, TVars>
  | WorkflowScenarioSendEventStep<TRegistry, TVars>
  | WorkflowScenarioEventAndRunUntilIdleStep<TRegistry, TVars>
  | WorkflowScenarioPauseStep<TRegistry, TVars>
  | WorkflowScenarioResumeStep<TRegistry, TVars>
  | WorkflowScenarioRetryStep<TRegistry, TVars>
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
  | WorkflowScenarioWaitForEmissionStep<TRegistry, TVars, TFragments>
  | WorkflowScenarioDrainHooksStep
  | WorkflowScenarioRestartStep
  | WorkflowScenarioCallRouteStep<TVars>
  | WorkflowScenarioConcurrentStep<string, TRegistry, TVars, TFragments, TClients>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | WorkflowScenarioWaitForStoreStep<TRegistry, TVars, TFragments, TClients, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | WorkflowScenarioReadStoreStep<TRegistry, TVars, TFragments, TClients, any>
  | WorkflowScenarioReadStep<TRegistry, TVars, TFragments, TClients>
  | WorkflowScenarioAssertStep<TRegistry, TVars, TFragments, TClients>;

export type WorkflowScenarioCreateStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "create";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  params?: ScenarioInput<unknown, TRegistry, TVars>;
  remoteWorkflowName?: ScenarioInput<string, TRegistry, TVars>;
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
  remoteWorkflowName?: ScenarioInput<string, TRegistry, TVars>;
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
  remoteWorkflowName?: ScenarioInput<string, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioSendEventStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "event";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  event: ScenarioInput<{ id?: string; type: string; payload?: unknown }, TRegistry, TVars>;
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
  event: ScenarioInput<{ id?: string; type: string; payload?: unknown }, TRegistry, TVars>;
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

export type WorkflowScenarioRetryStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
> = {
  type: "retry";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  stepKey?: ScenarioInput<string, TRegistry, TVars>;
  delayMs?: ScenarioInput<number, TRegistry, TVars>;
  reason?: ScenarioInput<string, TRegistry, TVars>;
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

export type WorkflowScenarioWaitForEmissionStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
> = {
  type: "waitForEmission";
  workflow: ScenarioInput<(keyof TRegistry & string) | string, TRegistry, TVars>;
  instanceId: ScenarioInput<string, TRegistry, TVars>;
  match?: (
    message: WorkflowScenarioObservedEmission,
    ctx: WorkflowScenarioContext<TRegistry, TVars, TFragments, unknown>,
  ) => boolean;
  timeoutMs?: ScenarioInput<number, TRegistry, TVars>;
  storeAs?: (keyof TVars & string) | undefined;
};

export type WorkflowScenarioDrainHooksStep = {
  type: "drainHooks";
};

export type WorkflowScenarioRestartStep = {
  type: "restart";
  runner?: string;
};

export type WorkflowScenarioCallRouteStep<TVars extends WorkflowScenarioVars> = {
  type: "callRoute";
  runner?: string;
  method: Parameters<WorkflowsTestRunner["callRoute"]>[0];
  path: string;
  options?: {
    pathParams?: Record<string, string>;
    body?: unknown;
  };
  storeAs?: (keyof TVars & string) | undefined;
  assert?: (response: WorkflowScenarioRouteResponse) => void | Promise<void>;
};

export type WorkflowScenarioConcurrentStep<
  TRunnerName extends string,
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
> = {
  type: "concurrent";
  branches: Partial<
    Record<TRunnerName, WorkflowScenarioStep<TRegistry, TVars, TFragments, TClients>[]>
  >;
};

export type WorkflowScenarioWaitForStoreStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
  TValue = unknown,
> = {
  type: "waitForStore";
  store: string;
  predicate: (value: TValue) => boolean;
  select?: (value: TValue) => unknown;
  storeAs?: (keyof TVars & string) | undefined;
  assert?: (
    value: WorkflowScenarioReadonlyValue<TValue>,
    ctx: WorkflowScenarioReadonlyContext<TRegistry, TVars, TFragments, TClients>,
  ) => void | Promise<void>;
};

export type WorkflowScenarioReadStoreStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
  TStore extends SubscribableStore<unknown> = SubscribableStore<unknown>,
  TValue = unknown,
> = {
  type: "readStore";
  store: string;
  read: (
    store: TStore,
    ctx: WorkflowScenarioContext<TRegistry, TVars, TFragments, TClients>,
  ) => TValue | Promise<TValue>;
  storeAs?: (keyof TVars & string) | undefined;
};

type WorkflowScenarioReadBaseStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
  TValue = unknown,
> = {
  type: "read";
  read: (
    ctx: WorkflowScenarioContext<TRegistry, TVars, TFragments, TClients>,
  ) => TValue | Promise<TValue>;
};

type WorkflowScenarioReadonlyValue<TValue> = unknown extends TValue
  ? TValue
  : TValue extends object
    ? Readonly<TValue>
    : TValue;

type WorkflowScenarioReadAssert<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
  TValue,
> = {
  assert(
    value: WorkflowScenarioReadonlyValue<TValue>,
    ctx: WorkflowScenarioReadonlyContext<TRegistry, TVars, TFragments, TClients>,
  ): void | Promise<void>;
}["assert"];

export type WorkflowScenarioReadStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
  TValue = unknown,
> = WorkflowScenarioReadBaseStep<TRegistry, TVars, TFragments, TClients, TValue> &
  (
    | {
        storeAs: keyof TVars & string;
        assert?: never;
      }
    | {
        storeAs?: undefined;
        assert: WorkflowScenarioReadAssert<TRegistry, TVars, TFragments, TClients, TValue>;
      }
    | {
        storeAs?: undefined;
        assert?: undefined;
      }
  );

export type WorkflowScenarioAssertStep<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
> = {
  type: "assert";
  assert: (
    ctx: WorkflowScenarioReadonlyContext<TRegistry, TVars, TFragments, TClients>,
  ) => void | Promise<void>;
};

export function defineScenario<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars = WorkflowScenarioVars,
  TConfigureFragments extends WorkflowScenarioFragmentConfigurator<TRegistry> | undefined =
    | WorkflowScenarioFragmentConfigurator<TRegistry>
    | undefined,
  TClients = Record<string, never>,
  const TRunners extends readonly string[] | undefined = undefined,
  TStores extends WorkflowScenarioStoreDefinitions<
    TRegistry,
    TVars,
    WorkflowScenarioFragmentsForConfigurator<TConfigureFragments>,
    TClients
  > = Record<string, never>,
>(
  scenario: WorkflowScenarioDefinitionInput<
    TRegistry,
    TVars,
    TConfigureFragments,
    TClients,
    TRunners,
    TStores
  >,
): WorkflowScenarioDefinition<
  TRegistry,
  TVars,
  WorkflowScenarioFragmentsForConfigurator<TConfigureFragments>,
  TClients,
  TRunners,
  TStores
> {
  return scenario;
}

type StepInput<TStep extends { type: string }> = Omit<TStep, "type">;

type RunnerNamedStep<TStep extends { type: string }, TRunnerName extends string> = TStep & {
  runner: TRunnerName;
};

const createScenarioWorkflowSteps = <
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
>() => {
  const raw = createRawScenarioStepBuilders<TRegistry, TVars, TFragments, TClients>();
  return {
    create: raw.create,
    createBatch: raw.createBatch,
    event: raw.event,
    pause: raw.pause,
    resume: raw.resume,
    retry: raw.retry,
    terminate: raw.terminate,
    read: raw.read,
    assert: raw.assert,
  };
};

const createScenarioRunnerSteps = <
  TRunnerName extends string,
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
>(
  runnerName: TRunnerName,
) => {
  const stampRunner = <TStep extends { type: string }>(
    step: TStep,
  ): RunnerNamedStep<TStep, TRunnerName> =>
    ({ ...step, runner: runnerName }) as RunnerNamedStep<TStep, TRunnerName>;
  const raw = createRawScenarioStepBuilders<TRegistry, TVars, TFragments>();
  return {
    initializeAndRunUntilIdle: (
      input: StepInput<WorkflowScenarioInitializeAndRunUntilIdleStep<TRegistry, TVars>>,
    ) => stampRunner(raw.initializeAndRunUntilIdle(input)),
    eventAndRunUntilIdle: (
      input: StepInput<WorkflowScenarioEventAndRunUntilIdleStep<TRegistry, TVars>>,
    ) => stampRunner(raw.eventAndRunUntilIdle(input)),
    resumeAndRunUntilIdle: (
      input: StepInput<WorkflowScenarioResumeAndRunUntilIdleStep<TRegistry, TVars>>,
    ) => stampRunner(raw.resumeAndRunUntilIdle(input)),
    runCreateUntilIdle: (
      input: StepInput<WorkflowScenarioRunCreateUntilIdleStep<TRegistry, TVars>>,
    ) => stampRunner(raw.runCreateUntilIdle(input)),
    runResumeUntilIdle: (
      input: StepInput<WorkflowScenarioRunResumeUntilIdleStep<TRegistry, TVars>>,
    ) => stampRunner(raw.runResumeUntilIdle(input)),
    retryAndRunUntilIdle: (
      input: StepInput<WorkflowScenarioRetryAndRunUntilIdleStep<TRegistry, TVars>>,
    ) => stampRunner(raw.retryAndRunUntilIdle(input)),
    runUntilIdle: (input: StepInput<WorkflowScenarioRunUntilIdleStep<TRegistry, TVars>>) =>
      stampRunner(raw.runUntilIdle(input)),
    tick: (input: StepInput<WorkflowScenarioTickStep<TRegistry, TVars>>) =>
      stampRunner(raw.tick(input)),
    advanceTimeAndRunUntilIdle: (
      input: StepInput<WorkflowScenarioAdvanceTimeAndRunUntilIdleStep<TRegistry, TVars>>,
    ) => stampRunner(raw.advanceTimeAndRunUntilIdle(input)),
    drainHooks: () => stampRunner(raw.drainHooks()),
    restart: () => stampRunner(raw.restart()),
    waitForEmission: (
      input: StepInput<WorkflowScenarioWaitForEmissionStep<TRegistry, TVars, TFragments>>,
    ) => stampRunner(raw.waitForEmission(input)),
    waitForControl: (input: StepInput<WorkflowScenarioWaitForControlStep<TRegistry, TVars>>) =>
      stampRunner(raw.waitForControl(input)),
    resolveControl: (input: StepInput<WorkflowScenarioResolveControlStep<TRegistry, TVars>>) =>
      stampRunner(raw.resolveControl(input)),
    rejectControl: (input: StepInput<WorkflowScenarioRejectControlStep<TRegistry, TVars>>) =>
      stampRunner(raw.rejectControl(input)),
    callRoute: (input: StepInput<WorkflowScenarioCallRouteStep<TVars>>) =>
      stampRunner({ type: "callRoute" as const, ...input }),
  };
};

const createScenarioHookSteps = <
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
>() => ({
  read: <TPayload = unknown>(
    input: WorkflowScenarioReadHooksOptions<TRegistry, TVars, TFragments, TClients, TPayload>,
  ): WorkflowScenarioReadStep<
    TRegistry,
    TVars,
    TFragments,
    TClients,
    WorkflowScenarioHookRow<TPayload>[]
  > => {
    const { fragment, hookName, status, where, storeAs, assert } = input;
    return {
      type: "read",
      read: async (ctx) => await ctx.hooks.get<TPayload>({ fragment, hookName, status, where }),
      storeAs,
      assert,
    } as WorkflowScenarioReadStep<
      TRegistry,
      TVars,
      TFragments,
      TClients,
      WorkflowScenarioHookRow<TPayload>[]
    >;
  },
});

const createScenarioStepsContext = <
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
  TRunners extends readonly string[] | undefined,
  TStores extends WorkflowScenarioStoreDefinitions<TRegistry, TVars, TFragments, TClients>,
>(
  runners: TRunners,
  clients: TClients,
  stores: WorkflowScenarioStoreHandles<TRegistry, TVars, TFragments, TClients, TStores>,
  lofi: LofiRuntime,
): TRunners extends readonly string[]
  ? WorkflowScenarioNamedStepsContext<
      TRunners[number],
      TRegistry,
      TVars,
      TFragments,
      TClients,
      TStores
    >
  : WorkflowScenarioDefaultStepsContext<TRegistry, TVars, TFragments, TClients, TStores> => {
  const workflow = createScenarioWorkflowSteps<TRegistry, TVars, TFragments, TClients>();
  const hooks = createScenarioHookSteps<TRegistry, TVars, TFragments, TClients>();
  if (runners) {
    const namedRunners = Object.fromEntries(
      runners.map((runnerName) => [
        runnerName,
        createScenarioRunnerSteps<typeof runnerName, TRegistry, TVars, TFragments>(runnerName),
      ]),
    );
    return {
      workflow,
      hooks,
      clients,
      stores,
      lofi,
      runners: namedRunners,
      concurrent: (branches) => ({ type: "concurrent", branches }),
    } as TRunners extends readonly string[]
      ? WorkflowScenarioNamedStepsContext<
          TRunners[number],
          TRegistry,
          TVars,
          TFragments,
          TClients,
          TStores
        >
      : WorkflowScenarioDefaultStepsContext<TRegistry, TVars, TFragments, TClients, TStores>;
  }

  return {
    workflow,
    hooks,
    runner: createScenarioRunnerSteps<"scenario", TRegistry, TVars, TFragments>("scenario"),
    clients,
    stores,
    lofi,
  } as TRunners extends readonly string[]
    ? WorkflowScenarioNamedStepsContext<
        TRunners[number],
        TRegistry,
        TVars,
        TFragments,
        TClients,
        TStores
      >
    : WorkflowScenarioDefaultStepsContext<TRegistry, TVars, TFragments, TClients, TStores>;
};

const createScenarioStoreHandles = <
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult>,
  TClients,
  TStores extends WorkflowScenarioStoreDefinitions<TRegistry, TVars, TFragments, TClients>,
>(
  storeDefinitions: TStores,
): WorkflowScenarioStoreHandles<TRegistry, TVars, TFragments, TClients, TStores> => {
  return Object.fromEntries(
    Object.keys(storeDefinitions).map((storeName) => [
      storeName,
      {
        waitFor: (
          predicate: (value: unknown) => boolean,
          options: WorkflowScenarioStoreWaitForOptions<
            TRegistry,
            TVars,
            TFragments,
            TClients,
            unknown
          > = {},
        ) => ({
          type: "waitForStore" as const,
          store: storeName,
          predicate,
          ...options,
        }),
        read: (
          read: (store: SubscribableStore<unknown>, ctx: WorkflowScenarioContext) => unknown,
          options: { storeAs?: keyof TVars & string } = {},
        ) => ({
          type: "readStore" as const,
          store: storeName,
          read,
          ...options,
        }),
      },
    ]),
  ) as unknown as WorkflowScenarioStoreHandles<TRegistry, TVars, TFragments, TClients, TStores>;
};

const createRawScenarioStepBuilders = <
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
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
  retry: (
    input: StepInput<WorkflowScenarioRetryStep<TRegistry, TVars>>,
  ): WorkflowScenarioRetryStep<TRegistry, TVars> => ({
    type: "retry",
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
  waitForEmission: (
    input: StepInput<WorkflowScenarioWaitForEmissionStep<TRegistry, TVars, TFragments>>,
  ): WorkflowScenarioWaitForEmissionStep<TRegistry, TVars, TFragments> => ({
    type: "waitForEmission",
    ...input,
  }),
  drainHooks: (): WorkflowScenarioDrainHooksStep => ({
    type: "drainHooks",
  }),
  restart: (): WorkflowScenarioRestartStep => ({
    type: "restart",
  }),
  read: <TValue>(
    input: StepInput<WorkflowScenarioReadStep<TRegistry, TVars, TFragments, TClients, TValue>>,
  ): WorkflowScenarioReadStep<TRegistry, TVars, TFragments, TClients, TValue> =>
    ({
      type: "read",
      ...input,
    }) as WorkflowScenarioReadStep<TRegistry, TVars, TFragments, TClients, TValue>,
  assert: (
    assert: WorkflowScenarioAssertStep<TRegistry, TVars, TFragments, TClients>["assert"],
  ): WorkflowScenarioAssertStep<TRegistry, TVars, TFragments, TClients> => ({
    type: "assert",
    assert,
  }),
});

const resolveScenarioInput = async <
  T,
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
>(
  input: ScenarioInput<T, TRegistry, TVars>,
  ctx: WorkflowScenarioContext<TRegistry, TVars, Record<string, AnyFragmentResult>, unknown>,
): Promise<T> => {
  if (typeof input === "function") {
    return await (
      input as (
        context: WorkflowScenarioContext<
          TRegistry,
          TVars,
          Record<string, AnyFragmentResult>,
          unknown
        >,
      ) => T | Promise<T>
    )(ctx);
  }
  return input;
};

type WorkflowResolver = {
  resolveName: (workflowNameOrKey: string) => string;
  assertName: (workflowName: string) => void;
};

const createWorkflowResolver = (workflows: WorkflowsRegistry): WorkflowResolver => {
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
  instanceId: string;
  workflowName: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  params: unknown;
  output: unknown;
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
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
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
    instanceId: string;
    params: unknown;
    output: unknown;
    errorName: string | null;
    errorMessage: string | null;
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
      result: unknown;
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
      payload: unknown;
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
      actor: WorkflowEventActor;
      payload: unknown;
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
    const workflowName = resolver.resolveName(workflow);
    const instance = await getScenarioInstanceRow(harness, workflowName, instanceId);
    return instance ? mapInstanceRow(instance) : null;
  };

  const getSteps = async (
    workflow: (keyof TRegistry & string) | string,
    instanceId: string,
    options?: { order?: "asc" | "desc" },
  ) => {
    const workflowName = resolver.resolveName(workflow);
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
    const workflowName = resolver.resolveName(workflow);
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
    options?: { order?: "asc" | "desc"; actor?: WorkflowEventActor; stepKey?: string },
  ) => {
    const workflowName = resolver.resolveName(workflow);
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
    const workflowName = resolver.resolveName(workflow);
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
    const workflowName = resolver.resolveName(workflow);
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
          result: unknown;
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
          payload: unknown;
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
          actor: WorkflowEventActor;
          payload: unknown;
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

const createScenarioHooks = <
  TRegistry extends WorkflowsRegistry,
  TFragments extends Record<string, AnyFragmentResult>,
>(
  fragments: WorkflowScenarioRuntimeFragments<TRegistry, TFragments>,
  state: WorkflowScenarioState<TRegistry>,
): WorkflowScenarioHooks<TRegistry, TFragments> => ({
  get: async <TPayload = unknown>(
    options: WorkflowScenarioGetHooksOptions<TRegistry, TFragments, TPayload>,
  ) => {
    const fragmentResult = fragments[options.fragment];
    if (!fragmentResult) {
      throw new Error(`SCENARIO_HOOKS_FRAGMENT_NOT_FOUND: ${options.fragment}`);
    }

    let namespace: string;
    let hooksEnabled: boolean;
    try {
      ({ namespace, hooksEnabled } = getDurableHooksService(
        fragmentResult.fragment as AnyFragnoInstantiatedDatabaseFragment,
      ));
    } catch (cause) {
      throw new Error(`SCENARIO_HOOKS_FRAGMENT_UNAVAILABLE: ${options.fragment}`, { cause });
    }

    if (!hooksEnabled) {
      throw new Error(`SCENARIO_HOOKS_NOT_ENABLED: ${options.fragment}`);
    }

    const records = (await state.internal.getHooks({
      namespace,
      hookName: options.hookName,
      status: options.status,
    })) as WorkflowScenarioHookRow<TPayload>[];

    return options.where ? records.filter(options.where) : records;
  },
});

const resolveScenarioRunnerNames = (runners: readonly string[] | undefined): string[] => {
  if (!runners) {
    return ["scenario"];
  }
  if (runners.length === 0) {
    throw new Error("SCENARIO_RUNNERS_EMPTY");
  }
  const reservedNames = new Set(["workflow", "concurrent", "runner", "runners", "lofi"]);
  const seen = new Set<string>();
  for (const runnerName of runners) {
    if (typeof runnerName !== "string" || runnerName.trim() === "") {
      throw new Error("SCENARIO_RUNNER_NAME_EMPTY");
    }
    if (reservedNames.has(runnerName)) {
      throw new Error(`SCENARIO_RUNNER_NAME_RESERVED: ${runnerName}`);
    }
    if (seen.has(runnerName)) {
      throw new Error(`SCENARIO_RUNNER_NAME_DUPLICATE: ${runnerName}`);
    }
    seen.add(runnerName);
  }
  return [...runners];
};

export async function runScenario<
  TRegistry extends WorkflowsRegistry,
  TVars extends WorkflowScenarioVars,
  TFragments extends Record<string, AnyFragmentResult> = Record<string, AnyFragmentResult>,
  TClients = Record<string, never>,
  TRunners extends readonly string[] | undefined = undefined,
  TStores extends WorkflowScenarioStoreDefinitions<TRegistry, TVars, TFragments, TClients> = Record<
    string,
    never
  >,
>(
  scenario: WorkflowScenarioDefinition<TRegistry, TVars, TFragments, TClients, TRunners, TStores>,
): Promise<WorkflowScenarioResult<TVars>> {
  const {
    adapter,
    testBuilder,
    autoTickHooks,
    fragmentConfig,
    configureFragments,
    ...harnessOptions
  } = scenario.harness ?? {};
  const createFragmentConfiguratorHarness = (
    fragments: Record<string, AnyFragmentResult>,
  ): WorkflowScenarioFragmentConfiguratorHarness<TRegistry> => {
    const workflowsResult = fragments["workflows"];
    if (!workflowsResult) {
      throw new Error("SCENARIO_WORKFLOWS_FRAGMENT_NOT_AVAILABLE");
    }

    return {
      fragments: fragments as WorkflowsTestHarness<TRegistry>["fragments"],
      fragment: workflowsResult.fragment as WorkflowsTestHarness<TRegistry>["fragment"],
      db: workflowsResult.db,
      services: workflowsResult.services as WorkflowsTestHarness<TRegistry>["services"],
      deps: workflowsResult.deps as WorkflowsTestHarness<TRegistry>["deps"],
      callRoute: workflowsResult.callRoute as WorkflowsTestHarness<TRegistry>["callRoute"],
    };
  };

  const createProbeWorkflowsResult = (): AnyFragmentResult => {
    const workflowServices = new Proxy({}, { get: () => () => undefined });
    return {
      fragment: { services: workflowServices } as AnyFragnoInstantiatedFragment,
      services: workflowServices,
      deps: {},
      callRoute: (() => {
        throw new Error("SCENARIO_CONFIGURE_FRAGMENTS_PROBE_ROUTE_CALLED");
      }) as AnyFragmentResult["callRoute"],
      db: undefined as unknown as TestDb,
    };
  };

  const configuredFragmentEntries = configureFragments
    ? Object.entries(
        configureFragments(
          createFragmentConfiguratorHarness({ workflows: createProbeWorkflowsResult() }),
        ),
      )
    : [];

  const harness = await createWorkflowsTestHarness({
    workflows: scenario.workflows,
    adapter: adapter ?? { type: "kysely-sqlite" },
    testBuilder: testBuilder ?? buildDatabaseFragmentsTest(),
    autoTickHooks: autoTickHooks ?? false,
    ...harnessOptions,
    fragmentConfig,
    configureBuilderAfterWorkflows:
      configuredFragmentEntries.length > 0
        ? (builder) => {
            let nextBuilder = builder;
            for (const [name, probeBuilder] of configuredFragmentEntries) {
              nextBuilder = nextBuilder.withFragmentFactory(
                name,
                probeBuilder.definition,
                ({ fragments }) => {
                  const configured = configureFragments!(
                    createFragmentConfiguratorHarness(fragments),
                  );
                  const fragmentOrBuilder = configured[name];
                  if (!fragmentOrBuilder || !("build" in fragmentOrBuilder)) {
                    throw new Error(`SCENARIO_CONFIGURED_FRAGMENT_BUILDER_NOT_FOUND: ${name}`);
                  }
                  return fragmentOrBuilder as never;
                },
              ) as never;
            }
            return nextBuilder;
          }
        : undefined,
  });

  const typedHarness = harness as unknown as WorkflowsTestHarness<TRegistry, TFragments>;
  const resolver = createWorkflowResolver(scenario.workflows);
  const mountedStoreCleanups: Array<() => void> = [];
  const mountedScenarioStores = new Map<string, SubscribableStore<unknown>>();

  const runnerNames = resolveScenarioRunnerNames(scenario.runners);
  const runnerInstances = new Map<string, WorkflowsTestRunner<TRegistry, TFragments>>(
    runnerNames.map((runnerName) => [runnerName, typedHarness.createRunner()]),
  );
  const getRunnerByName = (runnerName: string) => {
    const runner = runnerInstances.get(runnerName);
    if (!runner) {
      throw new Error(`SCENARIO_UNKNOWN_RUNNER: ${runnerName}`);
    }
    return runner;
  };
  const getRunnerForStep = (step: { runner?: string; type: string }) => {
    const runnerName = step.runner ?? "scenario";
    const runner = runnerInstances.get(runnerName);
    if (!runner) {
      throw new Error(`SCENARIO_UNKNOWN_RUNNER: ${runnerName} for ${step.type}`);
    }
    return runner;
  };
  const createRequest = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    baseUrl: string,
  ) => {
    if (input instanceof Request) {
      return init ? new Request(input, init) : input;
    }

    const url = input instanceof URL ? input : new URL(input, baseUrl);
    return new Request(url, init);
  };
  const createClientConfig = (
    fallbackFragments: WorkflowScenarioRuntimeFragments<TRegistry, TFragments>,
    resolveFallbackFragments: () =>
      | WorkflowScenarioRuntimeFragments<TRegistry, TFragments>
      | Promise<WorkflowScenarioRuntimeFragments<TRegistry, TFragments>>,
  ): WorkflowScenarioClientConfig<TRegistry, TFragments, WorkflowScenarioRunnerName<TRunners>> => {
    return ((fragmentName, options = {}) => {
      const fallbackFragment = fallbackFragments[fragmentName];
      if (!fallbackFragment) {
        throw new Error(`SCENARIO_CLIENT_FRAGMENT_NOT_FOUND: ${fragmentName}`);
      }

      const baseUrl = options.baseUrl ?? "http://fragno.test";
      const runnerName = options.runner;
      return {
        baseUrl,
        mountRoute: options.mountRoute ?? fallbackFragment.fragment.mountRoute,
        fetcherConfig: {
          type: "function",
          useOnServer: true,
          fetcher: async (input, init) => {
            const fragments = runnerName
              ? await getRunnerByName(runnerName).getFragments()
              : await resolveFallbackFragments();
            const fragment = fragments[fragmentName]?.fragment;
            if (!fragment) {
              throw new Error(`SCENARIO_CLIENT_FRAGMENT_NOT_FOUND: ${fragmentName}`);
            }
            return fragment.handler(createRequest(input, init, baseUrl), options.lifecycleContext);
          },
        },
      };
    }) as WorkflowScenarioClientConfig<TRegistry, TFragments, WorkflowScenarioRunnerName<TRunners>>;
  };
  const createClients = (
    fragments: WorkflowScenarioRuntimeFragments<TRegistry, TFragments>,
    resolveFragments: () =>
      | WorkflowScenarioRuntimeFragments<TRegistry, TFragments>
      | Promise<WorkflowScenarioRuntimeFragments<TRegistry, TFragments>> = () => fragments,
  ): TClients =>
    scenario.clients?.({
      fragments,
      createFragmentTestClientConfig,
      clientConfig: createClientConfig(fragments, resolveFragments),
    }) ?? ({} as TClients);
  const createClientRuntime = async (): Promise<
    WorkflowScenarioClientRuntime<TRegistry, TFragments, TClients>
  > => {
    const runtime = await typedHarness.test.createAdditionalRuntime();
    const fragments = runtime.fragments as WorkflowScenarioRuntimeFragments<TRegistry, TFragments>;

    return {
      fragments,
      clients: createClients(
        fragments,
        () => runtime.fragments as WorkflowScenarioRuntimeFragments<TRegistry, TFragments>,
      ),
      recreateFragments: runtime.recreateFragments,
    };
  };
  const createLofiFetch = (): typeof fetch =>
    (async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl);
      const query: Record<string, string> = {};
      const afterVersionstamp = url.searchParams.get("afterVersionstamp");
      const limit = url.searchParams.get("limit");
      if (afterVersionstamp) {
        query["afterVersionstamp"] = afterVersionstamp;
      }
      if (limit) {
        query["limit"] = limit;
      }

      const response = await typedHarness.fragments.workflows.fragment.callRoute(
        "GET",
        "/_internal/outbox" as never,
        { query } as never,
      );
      if (
        typeof response !== "object" ||
        response === null ||
        !("type" in response) ||
        response.type !== "json" ||
        !("data" in response)
      ) {
        throw new Error("SCENARIO_LOFI_OUTBOX_RESPONSE_INVALID");
      }
      return new Response(JSON.stringify(response.data));
    }) as typeof fetch;
  const lofi = createLofiRuntime({
    endpointName: `workflow-scenario:${scenario.name}`,
    adapter: new InMemoryLofiAdapter({
      endpointName: `workflow-scenario:${scenario.name}`,
      schemas: [workflowsSchema],
      ignoreUnknownSchemas: true,
    }),
    outboxUrl: "https://scenario.test/_internal/outbox",
    fetch: createLofiFetch(),
    autoStart: false,
  });
  const shouldDrainLofi = harnessOptions.fragmentOptions?.outbox?.enabled === true;
  const clients = createClients(typedHarness.fragments);
  const storeDefinitions =
    scenario.stores?.({
      fragments: typedHarness.fragments,
      clients,
      lofi,
      store: (factory) => factory,
    }) ?? ({} as TStores);
  const stores = createScenarioStoreHandles<TRegistry, TVars, TFragments, TClients, TStores>(
    storeDefinitions,
  );
  const resolvedSteps = scenario.steps(
    createScenarioStepsContext<TRegistry, TVars, TFragments, TClients, TRunners, TStores>(
      scenario.runners as TRunners,
      clients,
      stores,
      lofi,
    ),
  );
  const state = createScenarioState(harness, resolver);
  const hooks = createScenarioHooks(typedHarness.fragments, state);
  const context: WorkflowScenarioContext<TRegistry, TVars, TFragments, TClients> = {
    name: scenario.name,
    harness: typedHarness,
    runtime: harness.runtime,
    clock: harness.clock,
    vars: scenario.vars?.() ?? {},
    state,
    hooks,
    clients,
    lofi,
    createClientRuntime,
    mountStore: (store) => {
      mountedStoreCleanups.push(store.subscribe(() => {}));
      return store;
    },
    waitForStore,
    cleanup: async () => {
      while (mountedStoreCleanups.length > 0) {
        mountedStoreCleanups.pop()?.();
      }
      mountedScenarioStores.clear();
      lofi.stop();
      await harness.test.cleanup();
    },
  };

  const getMountedScenarioStore = (storeName: string): SubscribableStore<unknown> => {
    const existing = mountedScenarioStores.get(storeName);
    if (existing) {
      return existing;
    }

    const createStore = storeDefinitions[storeName];
    if (!createStore) {
      throw new Error(`SCENARIO_STORE_NOT_FOUND: ${storeName}`);
    }

    const mountedStore = context.mountStore(createStore(context));
    mountedScenarioStores.set(storeName, mountedStore);
    return mountedStore;
  };

  const buildPayload = async (options: {
    workflow: (keyof TRegistry & string) | string;
    instanceId: string;
    reason: WorkflowEnqueuedHookPayload["reason"];
    timestamp?: Date;
  }): Promise<WorkflowEnqueuedHookPayload> => {
    const workflowName = resolver.resolveName(options.workflow);
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
      reason: options.reason,
    };
  };

  const drainLofi = async () => {
    if (shouldDrainLofi) {
      await lofi.syncOnce();
    }
  };

  const executeSteps = async (
    scenarioSteps: WorkflowScenarioStep<TRegistry, TVars, TFragments, TClients>[],
  ) => {
    for (const step of scenarioSteps) {
      const stepRunnerName = (step as { runner?: string }).runner;
      const currentRunner = stepRunnerName
        ? getRunnerForStep({ runner: stepRunnerName, type: step.type })
        : (runnerInstances.get("scenario") ?? runnerInstances.values().next().value);
      if (!currentRunner) {
        throw new Error(`SCENARIO_NO_RUNNER_AVAILABLE: ${step.type}`);
      }
      switch (step.type) {
        case "create": {
          const workflowName = resolver.resolveName(
            await resolveScenarioInput(step.workflow, context),
          );
          const params = step.params ? await resolveScenarioInput(step.params, context) : undefined;
          const id = step.id ? await resolveScenarioInput(step.id, context) : undefined;
          const remoteWorkflowName = step.remoteWorkflowName
            ? await resolveScenarioInput(step.remoteWorkflowName, context)
            : undefined;
          const instanceId = await context.harness.createInstance(workflowName, {
            ...(id ? { id } : {}),
            ...(params ? { params } : {}),
            ...(remoteWorkflowName ? { remoteWorkflowName } : {}),
          });
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = instanceId;
          }
          break;
        }
        case "initializeAndRunUntilIdle": {
          const workflowName = resolver.resolveName(
            await resolveScenarioInput(step.workflow, context),
          );
          const params = step.params ? await resolveScenarioInput(step.params, context) : undefined;
          const id = step.id ? await resolveScenarioInput(step.id, context) : undefined;
          const remoteWorkflowName = step.remoteWorkflowName
            ? await resolveScenarioInput(step.remoteWorkflowName, context)
            : undefined;
          const instanceId = await context.harness.createInstance(workflowName, {
            ...(id ? { id } : {}),
            ...(params ? { params } : {}),
            ...(remoteWorkflowName ? { remoteWorkflowName } : {}),
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
          const resultTicks = await currentRunner.runUntilIdle(
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
            await resolveScenarioInput(step.workflow, context),
          );
          const instances = await resolveScenarioInput(step.instances, context);
          const remoteWorkflowName = step.remoteWorkflowName
            ? await resolveScenarioInput(step.remoteWorkflowName, context)
            : undefined;
          const resultInstances = await context.harness.createBatch(
            workflowName,
            instances,
            remoteWorkflowName ? { remoteWorkflowName } : {},
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = resultInstances;
          }
          break;
        }
        case "event": {
          const workflowName = resolver.resolveName(
            await resolveScenarioInput(step.workflow, context),
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
            await resolveScenarioInput(step.workflow, context),
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
          const resultTicks = await currentRunner.runUntilIdle(
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
            await resolveScenarioInput(step.workflow, context),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const status = await context.harness.pauseInstance(workflowName, instanceId);
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = status;
          }
          break;
        }
        case "resume": {
          const workflowName = resolver.resolveName(
            await resolveScenarioInput(step.workflow, context),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const status = await context.harness.resumeInstance(workflowName, instanceId);
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = status;
          }
          break;
        }
        case "retry": {
          const workflowName = resolver.resolveName(
            await resolveScenarioInput(step.workflow, context),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const stepKey = step.stepKey
            ? await resolveScenarioInput(step.stepKey, context)
            : undefined;
          const delayMs = step.delayMs
            ? await resolveScenarioInput(step.delayMs, context)
            : undefined;
          const reason = step.reason ? await resolveScenarioInput(step.reason, context) : undefined;
          const status = await context.harness.retryInstance(workflowName, instanceId, {
            stepKey,
            delayMs,
            reason,
          });
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = status;
          }
          break;
        }
        case "resumeAndRunUntilIdle": {
          const workflowName = resolver.resolveName(
            await resolveScenarioInput(step.workflow, context),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const status = await context.harness.resumeInstance(workflowName, instanceId);
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = status;
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
          const resultTicks = await currentRunner.runUntilIdle(
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
            await resolveScenarioInput(step.workflow, context),
          );
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const status = await context.harness.terminateInstance(workflowName, instanceId);
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = status;
          }
          break;
        }
        case "runCreateUntilIdle": {
          const workflowName = resolver.resolveName(
            await resolveScenarioInput(step.workflow, context),
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
          const resultTicks = await currentRunner.runUntilIdle(
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
            await resolveScenarioInput(step.workflow, context),
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
          const resultTicks = await currentRunner.runUntilIdle(
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
            await resolveScenarioInput(step.workflow, context),
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
          const resultTicks = await currentRunner.runUntilIdle(
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

          const processed = await currentRunner.tick(payload);
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

          const resultTicks = await currentRunner.runUntilIdle(
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
            await resolveScenarioInput(step.workflow, context),
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
          const resultTicks = await currentRunner.runUntilIdle(
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
        case "waitForEmission": {
          const workflowKey = await resolveScenarioInput(step.workflow, context);
          const workflowName = resolver.resolveName(workflowKey);
          const instanceId = await resolveScenarioInput(step.instanceId, context);
          const timeoutMs = step.timeoutMs
            ? await resolveScenarioInput(step.timeoutMs, context)
            : 2_000;
          const findPersistedMatch = async () => {
            const persisted = await context.state.getEmissions(workflowKey, instanceId);
            return persisted
              .map((message) => ({
                ...message,
                id: String(message.id),
                workflowName,
                instanceId,
              }))
              .find((message) => (step.match ? step.match(message, context) : true));
          };
          const alreadyMatched = await findPersistedMatch();
          if (alreadyMatched) {
            if (step.storeAs) {
              (context.vars as Record<string, unknown>)[step.storeAs] = alreadyMatched;
            }
            break;
          }
          const workflowFragment = (await currentRunner.getFragments()).workflows.fragment;
          const matched = await workflowFragment.inContext(async function () {
            const handle = workflowFragment.$internal.deps.stepEmissions.getOrCreate(
              workflowStepLivePumpKey(workflowName, instanceId),
              () =>
                createWorkflowStepLivePump({
                  handlerTx: this.handlerTx.bind(this),
                  workflowName,
                  instanceId,
                }),
            );
            handle.pump.setHandlerTx(this.handlerTx.bind(this));
            return await new Promise<WorkflowScenarioObservedEmission | undefined>((resolve) => {
              let unsubscribe: () => void = () => {};
              const timeout = setTimeout(() => {
                unsubscribe();
                void handle.close();
                resolve(undefined);
              }, timeoutMs);
              timeout.unref?.();
              unsubscribe = handle.pump.observe((message) => {
                const observed = { workflowName, instanceId, ...message };
                if (step.match && !step.match(observed, context)) {
                  return;
                }
                clearTimeout(timeout);
                unsubscribe();
                void handle.close();
                resolve(observed);
              });
            });
          });
          const persistedAfterTimeout = matched ?? (await findPersistedMatch());
          if (!persistedAfterTimeout) {
            throw new Error(`EMISSION_NOT_OBSERVED: ${workflowName}/${instanceId}`);
          }
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = persistedAfterTimeout;
          }
          break;
        }
        case "drainHooks": {
          await currentRunner.drainHooks();
          break;
        }
        case "restart": {
          await currentRunner.restart();
          break;
        }
        case "callRoute": {
          const response = await currentRunner.callRoute(
            step.method,
            step.path,
            step.options as Parameters<WorkflowsTestRunner["callRoute"]>[2],
          );
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = response;
          }
          if (step.assert) {
            await step.assert(response as WorkflowScenarioRouteResponse);
          }
          break;
        }
        case "concurrent": {
          await Promise.all(
            Object.entries(step.branches).map(async ([branchName, branchSteps]) => {
              if (!runnerInstances.has(branchName)) {
                throw new Error(`SCENARIO_UNKNOWN_RUNNER: ${branchName} for concurrent`);
              }
              if (!branchSteps || branchSteps.length === 0) {
                throw new Error(`SCENARIO_CONCURRENT_BRANCH_EMPTY: ${branchName}`);
              }
              for (const branchStep of branchSteps) {
                const runnerOwnedStep = branchStep as { runner?: string; type: string };
                if (runnerOwnedStep.runner && runnerOwnedStep.runner !== branchName) {
                  throw new Error(
                    `SCENARIO_CONCURRENT_BRANCH_RUNNER_MISMATCH: ${branchName} contains ${runnerOwnedStep.runner}`,
                  );
                }
              }
              await executeSteps(branchSteps);
            }),
          );
          break;
        }
        case "waitForStore": {
          const store = getMountedScenarioStore(step.store);
          const value = await waitForStore(store, step.predicate as (value: unknown) => boolean);
          const selectedValue = step.select ? step.select(value) : value;
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = selectedValue;
          }
          if (step.assert) {
            await step.assert(value, context);
          }
          break;
        }
        case "readStore": {
          const store = getMountedScenarioStore(step.store);
          const value = await step.read(store, context);
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = value;
          }
          break;
        }
        case "read": {
          const value = await step.read(context);
          if (step.storeAs && step.assert) {
            throw new Error("SCENARIO_READ_STEP_STORE_AS_AND_ASSERT_ARE_MUTUALLY_EXCLUSIVE");
          }
          if (step.storeAs) {
            (context.vars as Record<string, unknown>)[step.storeAs] = value;
          }
          if (step.assert) {
            await step.assert(value, context);
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
      await drainLofi();
    }
  };

  let result: WorkflowScenarioResult<TVars> | undefined;
  let scenarioError: unknown;

  try {
    await executeSteps(resolvedSteps);

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
    throw scenarioError instanceof Error ? scenarioError : new Error(String(scenarioError));
  }

  if (!result) {
    throw new Error("Scenario did not produce a result");
  }

  return result;
}
