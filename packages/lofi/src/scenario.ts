import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { AnySchema } from "@fragno-dev/db/schema";
import type { ReadableAtom } from "nanostores";

import { defineFragment, instantiate, type AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import { InMemoryAdapter, withDatabase, type SyncCommandRegistry } from "@fragno-dev/db";
import { toNodeHandler } from "@fragno-dev/node";

import { InMemoryLofiAdapter } from "./adapters/in-memory/adapter";
import type { InMemoryLofiStore } from "./adapters/in-memory/store";
import { StackedLofiAdapter } from "./adapters/stacked/adapter";
import { LofiClient } from "./client/client";
import { IndexedDbAdapter } from "./indexeddb/adapter";
import { LofiOverlayManager } from "./optimistic/overlay-manager";
import type { LofiFindBuilder } from "./query/read-plan";
import { createLofiQueryStore, createLofiRuntime, isLofiRuntimeBootstrapped } from "./reactive";
import type { LofiQueryState, LofiRuntime, LofiRuntimeSyncResult } from "./reactive";
import { LofiSubmitClient } from "./submit/client";
import type {
  AnyLofiLocalProjection,
  LofiAdapter,
  LofiQueryInterface,
  LofiQueryableAdapter,
  LofiSubmitCommandDefinition,
  LofiSubmitCommandTarget,
  LofiSubmitResponse,
  LofiSyncResult,
} from "./types";

export type ScenarioServerConfig<TSchema extends AnySchema = AnySchema> =
  | {
      fragmentName: string;
      schema: TSchema;
      syncCommands: SyncCommandRegistry;
      port?: number;
      baseUrl?: string;
    }
  | {
      fragment: AnyFragnoInstantiatedFragment;
      schema: TSchema;
      port?: number;
      baseUrl?: string;
    };

export type ScenarioOutboxSourceConfig = {
  id: string;
  outboxUrl?: string | ((options: { baseUrl: string }) => string);
  cursorKey?: string;
  pollIntervalMs?: number;
};

export type ScenarioClientFetchFactory = (options: {
  baseFetch: typeof fetch;
  baseUrl: string;
  clientName: string;
}) => typeof fetch;

export type ScenarioClientConfig = {
  endpointName: string;
  adapter?: ScenarioClientAdapterConfig;
  sources?: ScenarioOutboxSourceConfig[];
  bootstrap?: boolean;
  fetch?: ScenarioClientFetchFactory;
};

export type ScenarioClientAdapterConfig =
  | {
      type: "indexeddb";
      dbName?: string;
    }
  | {
      type: "in-memory";
      store?: InMemoryLofiStore;
    }
  | {
      type: "stacked";
      base?: "indexeddb" | "in-memory";
      baseDbName?: string;
      baseStore?: InMemoryLofiStore;
      overlayStore?: InMemoryLofiStore;
    };

type NoInfer<T> = [T][T extends T ? 0 : never];
type BivariantCallback<T extends (...args: never[]) => unknown> = {
  bivarianceHack: T;
}["bivarianceHack"];
type ScenarioVars = Record<string, unknown>;
type KeysMatching<T, V> = {
  [K in keyof T]-?: Extract<T[K], V> extends never ? never : K;
}[keyof T];

export type ScenarioIndexedDbGlobals = {
  indexedDB: unknown;
  IDBCursor?: unknown;
  IDBDatabase?: unknown;
  IDBIndex?: unknown;
  IDBKeyRange?: unknown;
  IDBObjectStore?: unknown;
  IDBOpenDBRequest?: unknown;
  IDBRequest?: unknown;
  IDBTransaction?: unknown;
};

type ScenarioGlobalRestore = () => void;

const installIndexedDbGlobals = (
  globals?: ScenarioIndexedDbGlobals,
): ScenarioGlobalRestore | undefined => {
  if (!globals) {
    return undefined;
  }
  const entries = Object.entries(globals) as Array<[keyof ScenarioIndexedDbGlobals, unknown]>;
  const previous = entries.map(([key]) => ({
    key,
    hadKey: key in globalThis,
    value: (globalThis as Record<string, unknown>)[key as string],
  }));

  for (const [key, value] of entries) {
    if (value !== undefined) {
      (globalThis as Record<string, unknown>)[key as string] = value;
    }
  }

  return () => {
    for (const entry of previous) {
      if (!entry.hadKey) {
        delete (globalThis as Record<string, unknown>)[entry.key as string];
        continue;
      }
      (globalThis as Record<string, unknown>)[entry.key as string] = entry.value;
    }
  };
};

export type ScenarioDefinition<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TCommands extends ReadonlyArray<LofiSubmitCommandDefinition> =
    ReadonlyArray<LofiSubmitCommandDefinition>,
  TVars extends ScenarioVars = ScenarioVars,
> = {
  name: string;
  server: ScenarioServerConfig<TSchema>;
  clientCommands: TCommands;
  clients: Record<string, ScenarioClientConfig>;
  localSchemas?: AnySchema[];
  localProjections?: AnyLofiLocalProjection[];
  steps: ScenarioStep<NoInfer<TSchema>, NoInfer<TCommandContext>, NoInfer<TVars>>[];
  createClientContext?: (clientName: string) => TCommandContext;
};

export type RunScenarioOptions = {
  indexedDbGlobals?: ScenarioIndexedDbGlobals;
};

type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

type ScenarioFragment = {
  handler: (req: Request) => Promise<Response>;
  callRouteRaw: (method: HTTPMethod, path: string, inputOptions?: unknown) => Promise<Response>;
};

export type ScenarioContext<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
> = {
  name: string;
  server: {
    adapter?: InMemoryAdapter;
    fragment: ScenarioFragment;
    baseUrl: string;
  };
  clients: Record<string, ScenarioClient<TSchema, TCommandContext>>;
  vars: Partial<TVars>;
  lastSubmit: Record<string, LofiSubmitResponse | undefined>;
  lastSync: Record<string, LofiSyncResult | LofiRuntimeSyncResult | undefined>;
  lastBootstrap: Record<string, LofiRuntimeSyncResult | undefined>;
  cleanup: () => Promise<void>;
};

type ScenarioPendingReactiveStore<TSchema extends AnySchema = AnySchema> = {
  schema: AnySchema;
  table: keyof TSchema["tables"] & string;
  query: (builder: unknown) => unknown;
  storeOptions:
    | { initialData: unknown; map?: undefined }
    | { initialData: unknown; map: (rows: unknown) => unknown };
};

export type ScenarioClient<TSchema extends AnySchema = AnySchema, TCommandContext = unknown> = {
  name: string;
  endpointName: string;
  adapter: LofiAdapter & LofiQueryableAdapter;
  submit: LofiSubmitClient<TCommandContext>;
  sync: LofiClient;
  runtime: LofiRuntime;
  query: LofiQueryInterface<TSchema>;
  baseQuery: LofiQueryInterface<TSchema>;
  overlayQuery?: LofiQueryInterface<TSchema>;
  createQueryEngine: <const T extends AnySchema>(schema: T) => LofiQueryInterface<T>;
  adapters: {
    base: LofiAdapter & LofiQueryableAdapter;
    overlay?: InMemoryLofiAdapter;
    stacked?: StackedLofiAdapter;
  };
  stores: {
    base?: InMemoryLofiStore;
    overlay?: InMemoryLofiStore;
    reactive?: Record<string, ReadableAtom<LofiQueryState<unknown>>>;
    serverRendered?: Record<string, LofiQueryState<unknown>>;
    pendingReactive?: Record<string, ScenarioPendingReactiveStore<TSchema>>;
  };
  storeProbes: Record<
    string,
    {
      values: LofiQueryState<unknown>[];
      unsubscribe: () => void;
    }
  >;
  overlayManager?: LofiOverlayManager<TCommandContext>;
};

type CommandInputFn<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
> = (ctx: ScenarioContext<TSchema, TCommandContext, TVars>) => unknown;

type ScenarioResolvableValue<TContext> =
  | { type: "value"; value: unknown }
  | { type: "resolver"; resolve: (context: TContext) => unknown };

const createScenarioResolvableValue = <TContext>(
  value: unknown,
): ScenarioResolvableValue<TContext> =>
  typeof value === "function"
    ? { type: "resolver", resolve: value as (context: TContext) => unknown }
    : { type: "value", value };

const resolveScenarioResolvableValue = async <TContext>(
  resolvable: ScenarioResolvableValue<TContext>,
  context: TContext,
): Promise<unknown> =>
  resolvable.type === "resolver" ? await resolvable.resolve(context) : resolvable.value;
type ReadFn<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
  T = unknown,
> =
  | BivariantCallback<(ctx: ScenarioContext<TSchema, TCommandContext, TVars>) => T | Promise<T>>
  | BivariantCallback<
      (
        ctx: ScenarioContext<TSchema, TCommandContext, TVars>,
        client: ScenarioClient<TSchema, TCommandContext>,
      ) => T | Promise<T>
    >;

export type ScenarioCommandStep<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
> = {
  type: "command";
  client: string;
  name: string;
  input: ScenarioResolvableValue<ScenarioContext<TSchema, TCommandContext, TVars>>;
  target?: LofiSubmitCommandTarget;
  optimistic?: boolean;
  submit?: boolean;
  storeCommandIdAs?: (KeysMatching<TVars, string> & string) | undefined;
};

export type ScenarioSubmitStep = {
  type: "submit";
  client: string;
};

export type ScenarioSyncStep = {
  type: "sync";
  client: string;
  sourceId?: string;
};

export type ScenarioBootstrapStep = {
  type: "bootstrap";
  client: string;
  sourceId?: string;
};

export type ScenarioWaitForBootstrapStep = {
  type: "waitForBootstrap";
  client: string;
  timeoutMs?: number;
};

export type ScenarioInitialData<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
> = ScenarioResolvableValue<ScenarioContext<TSchema, TCommandContext, TVars>>;

export type ScenarioCreateStoreStep<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
> = {
  type: "createStore";
  client: string;
  name: string;
  schema?: AnySchema;
  table: keyof TSchema["tables"] & string;
  query: (builder: unknown) => unknown;
  initialData: ScenarioInitialData<TSchema, TCommandContext, TVars>;
  map?: (rows: unknown, ctx: ScenarioContext<TSchema, TCommandContext, TVars>) => unknown;
  mount?: boolean;
};

export type ScenarioReadStoreStep<
  TVars extends ScenarioVars = ScenarioVars,
  K extends keyof TVars = keyof TVars,
> = {
  type: "readStore";
  client: string;
  name: string;
  storeAs: K;
};

export type ScenarioReadStoreStateStep<
  TVars extends ScenarioVars = ScenarioVars,
  K extends keyof TVars = keyof TVars,
> = {
  type: "readStoreState";
  client: string;
  name: string;
  storeAs: K;
};

export type ScenarioMountStoreStep = {
  type: "mountStore";
  client: string;
  name: string;
};

export type ScenarioWaitForStoreStep = {
  type: "waitForStore";
  client: string;
  name: string;
  predicate: (state: LofiQueryState<unknown>) => boolean;
  timeoutMs?: number;
};

export type ScenarioAssertStoreEmissionsStep = {
  type: "assertStoreEmissions";
  client: string;
  name: string;
  assert: (values: LofiQueryState<unknown>[]) => void | Promise<void>;
};

export type ScenarioReadStepWithStore<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
  K extends keyof TVars = keyof TVars,
> = {
  type: "read";
  client: string;
  read: ReadFn<TSchema, TCommandContext, TVars, TVars[K]>;
  storeAs: K;
};

export type ScenarioReadStepNoStore<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
> = {
  type: "read";
  client: string;
  read: ReadFn<TSchema, TCommandContext, TVars>;
  storeAs?: undefined;
};

export type ScenarioReadStep<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
> =
  | ScenarioReadStepWithStore<TSchema, TCommandContext, TVars>
  | ScenarioReadStepNoStore<TSchema, TCommandContext, TVars>;

export type ScenarioAssertStep<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
> = {
  type: "assert";
  assert: BivariantCallback<
    (ctx: ScenarioContext<TSchema, TCommandContext, TVars>) => void | Promise<void>
  >;
};

export type ScenarioStep<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
> =
  | ScenarioCommandStep<TSchema, TCommandContext, TVars>
  | ScenarioSubmitStep
  | ScenarioSyncStep
  | ScenarioBootstrapStep
  | ScenarioWaitForBootstrapStep
  | ScenarioReadStep<TSchema, TCommandContext, TVars>
  | ScenarioCreateStoreStep<TSchema, TCommandContext, TVars>
  | ScenarioReadStoreStep<TVars>
  | ScenarioReadStoreStateStep<TVars>
  | ScenarioMountStoreStep
  | ScenarioWaitForStoreStep
  | ScenarioAssertStoreEmissionsStep
  | ScenarioAssertStep<TSchema, TCommandContext, TVars>;

export function defineScenario<
  TSchema extends AnySchema,
  TCommandContext,
  TCommands extends ReadonlyArray<LofiSubmitCommandDefinition> =
    ReadonlyArray<LofiSubmitCommandDefinition>,
  TVars extends ScenarioVars = ScenarioVars,
>(
  scenario: ScenarioDefinition<TSchema, TCommandContext, TCommands, TVars> & {
    createClientContext: (clientName: string) => TCommandContext;
  },
): ScenarioDefinition<TSchema, TCommandContext, TCommands, TVars>;
export function defineScenario<
  TSchema extends AnySchema,
  TCommandContext = unknown,
  TCommands extends ReadonlyArray<LofiSubmitCommandDefinition> =
    ReadonlyArray<LofiSubmitCommandDefinition>,
  TVars extends ScenarioVars = ScenarioVars,
>(
  scenario: ScenarioDefinition<TSchema, TCommandContext, TCommands, TVars>,
): ScenarioDefinition<TSchema, TCommandContext, TCommands, TVars>;
export function defineScenario(scenario: ScenarioDefinition): ScenarioDefinition {
  return scenario;
}

function command<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
>(
  client: string,
  name: string,
  input: CommandInputFn<TSchema, TCommandContext, TVars>,
  options?: {
    target?: LofiSubmitCommandTarget;
    optimistic?: boolean;
    submit?: boolean;
    storeCommandIdAs?: (KeysMatching<TVars, string> & string) | undefined;
  },
): ScenarioCommandStep<TSchema, TCommandContext, TVars>;
function command<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
>(
  client: string,
  name: string,
  input: unknown,
  options?: {
    target?: LofiSubmitCommandTarget;
    optimistic?: boolean;
    submit?: boolean;
    storeCommandIdAs?: (KeysMatching<TVars, string> & string) | undefined;
  },
): ScenarioCommandStep<TSchema, TCommandContext, TVars>;
function command<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
>(
  client: string,
  name: string,
  input: unknown,
  options?: {
    target?: LofiSubmitCommandTarget;
    optimistic?: boolean;
    submit?: boolean;
    storeCommandIdAs?: (KeysMatching<TVars, string> & string) | undefined;
  },
): ScenarioCommandStep<TSchema, TCommandContext, TVars> {
  return {
    type: "command",
    client,
    name,
    input: createScenarioResolvableValue<ScenarioContext<TSchema, TCommandContext, TVars>>(input),
    target: options?.target,
    optimistic: options?.optimistic,
    submit: options?.submit,
    storeCommandIdAs: options?.storeCommandIdAs,
  };
}

const submit = (client: string): ScenarioSubmitStep => ({ type: "submit", client });
const sync = (client: string, sourceId?: string): ScenarioSyncStep => ({
  type: "sync",
  client,
  sourceId,
});
const bootstrap = (client: string, sourceId?: string): ScenarioBootstrapStep => ({
  type: "bootstrap",
  client,
  sourceId,
});
const waitForBootstrap = (
  client: string,
  options?: { timeoutMs?: number },
): ScenarioWaitForBootstrapStep => ({
  type: "waitForBootstrap",
  client,
  timeoutMs: options?.timeoutMs,
});
function read<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
  K extends keyof TVars = keyof TVars,
>(
  client: string,
  read: ReadFn<TSchema, TCommandContext, TVars, TVars[K]>,
  storeAs: K,
): ScenarioReadStepWithStore<TSchema, TCommandContext, TVars, K>;
function read<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
>(
  client: string,
  read: ReadFn<TSchema, TCommandContext, TVars>,
  storeAs?: undefined,
): ScenarioReadStepNoStore<TSchema, TCommandContext, TVars>;
function read<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
>(
  client: string,
  read: ReadFn<TSchema, TCommandContext, TVars>,
  storeAs?: keyof TVars,
): ScenarioReadStep<TSchema, TCommandContext, TVars> {
  if (storeAs === undefined) {
    return { type: "read", client, read } as ScenarioReadStepNoStore<
      TSchema,
      TCommandContext,
      TVars
    >;
  }
  return { type: "read", client, read, storeAs } as ScenarioReadStepWithStore<
    TSchema,
    TCommandContext,
    TVars
  >;
}
function assert<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
>(
  assert: ScenarioAssertStep<TSchema, TCommandContext, TVars>["assert"],
): ScenarioAssertStep<TSchema, TCommandContext, TVars> {
  return {
    type: "assert",
    assert,
  };
}
type ScenarioCreateStoreOptions<
  TSchema extends AnySchema,
  TCommandContext,
  TVars extends ScenarioVars,
> = {
  schema?: AnySchema;
  initialData?: unknown;
  map?: (rows: unknown, ctx: ScenarioContext<TSchema, TCommandContext, TVars>) => unknown;
  mount?: boolean;
};

type ScenarioCreateStoreResolverOptions<
  TSchema extends AnySchema,
  TCommandContext,
  TVars extends ScenarioVars,
> = Omit<ScenarioCreateStoreOptions<TSchema, TCommandContext, TVars>, "initialData"> & {
  initialData: (ctx: ScenarioContext<TSchema, TCommandContext, TVars>) => unknown;
};

function createStore<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
  TTableName extends keyof TSchema["tables"] & string = keyof TSchema["tables"] & string,
>(
  client: string,
  name: string,
  table: TTableName,
  query: (builder: LofiFindBuilder<TSchema, TTableName>) => unknown,
  options: ScenarioCreateStoreResolverOptions<TSchema, TCommandContext, TVars>,
): ScenarioCreateStoreStep<TSchema, TCommandContext, TVars>;
function createStore<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
  TTableName extends keyof TSchema["tables"] & string = keyof TSchema["tables"] & string,
>(
  client: string,
  name: string,
  table: TTableName,
  query: (builder: LofiFindBuilder<TSchema, TTableName>) => unknown,
  options?: ScenarioCreateStoreOptions<TSchema, TCommandContext, TVars>,
): ScenarioCreateStoreStep<TSchema, TCommandContext, TVars>;
function createStore<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
  TTableName extends keyof TSchema["tables"] & string = keyof TSchema["tables"] & string,
>(
  client: string,
  name: string,
  table: TTableName,
  query: (builder: LofiFindBuilder<TSchema, TTableName>) => unknown,
  options?: ScenarioCreateStoreOptions<TSchema, TCommandContext, TVars>,
): ScenarioCreateStoreStep<TSchema, TCommandContext, TVars> {
  return {
    type: "createStore",
    client,
    name,
    schema: options?.schema,
    table,
    query: query as (builder: unknown) => unknown,
    initialData: createScenarioResolvableValue<ScenarioContext<TSchema, TCommandContext, TVars>>(
      options?.initialData,
    ),
    map: options?.map,
    mount: options?.mount,
  };
}
const readStore = <TVars extends ScenarioVars = ScenarioVars, K extends keyof TVars = keyof TVars>(
  client: string,
  name: string,
  storeAs: K,
): ScenarioReadStoreStep<TVars, K> => ({
  type: "readStore",
  client,
  name,
  storeAs,
});
const readStoreState = <
  TVars extends ScenarioVars = ScenarioVars,
  K extends keyof TVars = keyof TVars,
>(
  client: string,
  name: string,
  storeAs: K,
): ScenarioReadStoreStateStep<TVars, K> => ({
  type: "readStoreState",
  client,
  name,
  storeAs,
});
const mountStore = (client: string, name: string): ScenarioMountStoreStep => ({
  type: "mountStore",
  client,
  name,
});
const waitForStore = (
  client: string,
  name: string,
  predicate: (state: LofiQueryState<unknown>) => boolean,
  options?: { timeoutMs?: number },
): ScenarioWaitForStoreStep => ({
  type: "waitForStore",
  client,
  name,
  predicate,
  timeoutMs: options?.timeoutMs,
});
const assertStoreEmissions = (
  client: string,
  name: string,
  assert: (values: LofiQueryState<unknown>[]) => void | Promise<void>,
): ScenarioAssertStoreEmissionsStep => ({
  type: "assertStoreEmissions",
  client,
  name,
  assert,
});
export const createScenarioSteps = <
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
  TVars extends ScenarioVars = ScenarioVars,
>() => ({
  command: (() => {
    function commandStep(
      client: string,
      name: string,
      input: CommandInputFn<TSchema, TCommandContext, TVars>,
      options?: {
        target?: LofiSubmitCommandTarget;
        optimistic?: boolean;
        submit?: boolean;
        storeCommandIdAs?: (KeysMatching<TVars, string> & string) | undefined;
      },
    ): ScenarioCommandStep<TSchema, TCommandContext, TVars>;
    function commandStep(
      client: string,
      name: string,
      input: unknown,
      options?: {
        target?: LofiSubmitCommandTarget;
        optimistic?: boolean;
        submit?: boolean;
        storeCommandIdAs?: (KeysMatching<TVars, string> & string) | undefined;
      },
    ): ScenarioCommandStep<TSchema, TCommandContext, TVars>;
    function commandStep(
      client: string,
      name: string,
      input: unknown,
      options?: {
        target?: LofiSubmitCommandTarget;
        optimistic?: boolean;
        submit?: boolean;
        storeCommandIdAs?: (KeysMatching<TVars, string> & string) | undefined;
      },
    ): ScenarioCommandStep<TSchema, TCommandContext, TVars> {
      return command<TSchema, TCommandContext, TVars>(client, name, input, options);
    }
    return commandStep;
  })(),
  submit,
  sync,
  bootstrap,
  waitForBootstrap,
  read: (<K extends keyof TVars>(
    client: string,
    readFn: ReadFn<TSchema, TCommandContext, TVars, TVars[K]>,
    storeAs: K,
  ) => read<TSchema, TCommandContext, TVars, K>(client, readFn, storeAs)) as {
    <K extends keyof TVars>(
      client: string,
      readFn: ReadFn<TSchema, TCommandContext, TVars, TVars[K]>,
      storeAs: K,
    ): ScenarioReadStepWithStore<TSchema, TCommandContext, TVars, K>;
    (
      client: string,
      readFn: ReadFn<TSchema, TCommandContext, TVars>,
      storeAs?: undefined,
    ): ScenarioReadStepNoStore<TSchema, TCommandContext, TVars>;
  },
  createStore: (() => {
    function createStoreStep<TTableName extends keyof TSchema["tables"] & string>(
      client: string,
      name: string,
      table: TTableName,
      query: (builder: LofiFindBuilder<TSchema, TTableName>) => unknown,
      options: ScenarioCreateStoreResolverOptions<TSchema, TCommandContext, TVars>,
    ): ScenarioCreateStoreStep<TSchema, TCommandContext, TVars>;
    function createStoreStep<TTableName extends keyof TSchema["tables"] & string>(
      client: string,
      name: string,
      table: TTableName,
      query: (builder: LofiFindBuilder<TSchema, TTableName>) => unknown,
      options?: ScenarioCreateStoreOptions<TSchema, TCommandContext, TVars>,
    ): ScenarioCreateStoreStep<TSchema, TCommandContext, TVars>;
    function createStoreStep<TTableName extends keyof TSchema["tables"] & string>(
      client: string,
      name: string,
      table: TTableName,
      query: (builder: LofiFindBuilder<TSchema, TTableName>) => unknown,
      options?: ScenarioCreateStoreOptions<TSchema, TCommandContext, TVars>,
    ): ScenarioCreateStoreStep<TSchema, TCommandContext, TVars> {
      return createStore<TSchema, TCommandContext, TVars, TTableName>(
        client,
        name,
        table,
        query,
        options,
      );
    }
    return createStoreStep;
  })(),
  readStore: <K extends keyof TVars>(client: string, name: string, storeAs: K) =>
    readStore<TVars, K>(client, name, storeAs),
  readStoreState: <K extends keyof TVars>(client: string, name: string, storeAs: K) =>
    readStoreState<TVars, K>(client, name, storeAs),
  mountStore,
  waitForStore,
  assertStoreEmissions,
  assert: (assertFn: ScenarioAssertStep<TSchema, TCommandContext, TVars>["assert"]) =>
    assert<TSchema, TCommandContext, TVars>(assertFn),
});

export const steps = createScenarioSteps();

const createServerFetch = (fragment: ScenarioFragment) => {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = ((init?.method ?? "GET").toUpperCase() as HTTPMethod) ?? "GET";
    const headers = init?.headers ? new Headers(init.headers) : undefined;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;

    return fragment.callRouteRaw(method, url.pathname, {
      query: url.searchParams,
      body,
      headers,
    });
  };
};

const resolveReadResult = async <
  TSchema extends AnySchema,
  TCommandContext,
  TVars extends ScenarioVars,
  T = unknown,
>(
  read: ReadFn<TSchema, TCommandContext, TVars, T>,
  ctx: ScenarioContext<TSchema, TCommandContext, TVars>,
  client: ScenarioClient<TSchema, TCommandContext>,
): Promise<T> => {
  if (read.length >= 2) {
    return await (
      read as (
        ctx: ScenarioContext<TSchema, TCommandContext, TVars>,
        client: ScenarioClient<TSchema, TCommandContext>,
      ) => T
    )(ctx, client);
  }
  return await (read as (ctx: ScenarioContext<TSchema, TCommandContext, TVars>) => T)(ctx);
};

type ScenarioClientAdapters<TCommandContext = unknown> = {
  adapter: LofiAdapter & LofiQueryableAdapter;
  baseAdapter: LofiAdapter & LofiQueryableAdapter;
  overlayAdapter?: InMemoryLofiAdapter;
  stackedAdapter?: StackedLofiAdapter;
  overlayManager?: LofiOverlayManager<TCommandContext>;
  baseStore?: InMemoryLofiStore;
  overlayStore?: InMemoryLofiStore;
};

const startScenarioServer = async (
  fragment: ScenarioFragment,
  port: number,
): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const server = createServer(toNodeHandler(fragment.handler));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
};

const resolveMountRoute = (fragment: ScenarioFragment): string | undefined => {
  if ("mountRoute" in fragment && typeof fragment.mountRoute === "string") {
    return fragment.mountRoute;
  }
  return undefined;
};

const resolveScenarioOutboxUrl = (source: ScenarioOutboxSourceConfig, baseUrl: string): string => {
  if (typeof source.outboxUrl === "function") {
    return source.outboxUrl({ baseUrl });
  }
  return source.outboxUrl ?? `${baseUrl}/_internal/outbox`;
};

const waitForScenarioStore = async (
  store: ReadableAtom<LofiQueryState<unknown>>,
  predicate: (state: LofiQueryState<unknown>) => boolean,
  timeoutMs = 1000,
): Promise<void> => {
  const start = Date.now();
  while (!predicate(store.get())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for scenario store.");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

const waitForScenarioBootstrap = async <TSchema extends AnySchema, TCommandContext>(
  client: ScenarioClient<TSchema, TCommandContext>,
  timeoutMs = 1000,
): Promise<void> => {
  const start = Date.now();
  while (!isLofiRuntimeBootstrapped(client.runtime.$status.get())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for scenario bootstrap: ${client.name} ${JSON.stringify(
          client.runtime.$status.get(),
        )}`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

const getScenarioReactiveStore = <TSchema extends AnySchema, TCommandContext>(
  client: ScenarioClient<TSchema, TCommandContext>,
  name: string,
): ReadableAtom<LofiQueryState<unknown>> => {
  const store = client.stores.reactive?.[name];
  if (!store) {
    throw new Error(`Unknown scenario store: ${client.name}.${name}`);
  }
  return store;
};

const mountScenarioReactiveStore = <TSchema extends AnySchema, TCommandContext>(
  client: ScenarioClient<TSchema, TCommandContext>,
  defaultSchema: TSchema,
  name: string,
  cleanupCallbacks: Array<() => void>,
): void => {
  if (client.storeProbes[name]) {
    throw new Error(`Scenario store is already mounted: ${client.name}.${name}`);
  }

  const pending = client.stores.pendingReactive?.[name];
  if (pending && !client.stores.reactive?.[name]) {
    const storeSchema = pending.schema ?? defaultSchema;
    client.stores.reactive ??= {};
    client.stores.reactive[name] = createLofiQueryStore(
      client.runtime,
      storeSchema as TSchema,
      pending.table,
      pending.query as (
        builder: LofiFindBuilder<TSchema, keyof TSchema["tables"] & string>,
      ) => unknown,
      pending.storeOptions as never,
    );
    delete client.stores.pendingReactive?.[name];
  }

  const store = getScenarioReactiveStore(client, name);
  const values: LofiQueryState<unknown>[] = [];
  const unsubscribe = store.subscribe((value) => {
    values.push(value);
  });
  cleanupCallbacks.push(unsubscribe);
  client.storeProbes[name] = { values, unsubscribe };
};

const resolveCommandTarget = <TCommandContext = unknown>(
  commandName: string,
  commands: ReadonlyArray<LofiSubmitCommandDefinition<unknown, TCommandContext>>,
): LofiSubmitCommandTarget | undefined => {
  for (const command of commands) {
    if (command.name === commandName) {
      return command.target;
    }
  }
  return undefined;
};

const isScenarioDefinitionConfig = <TSchema extends AnySchema>(
  config: ScenarioServerConfig<TSchema>,
): config is Extract<
  ScenarioServerConfig<TSchema>,
  { fragmentName: string; schema: TSchema; syncCommands: SyncCommandRegistry }
> => "fragmentName" in config;

const isScenarioFragmentConfig = <TSchema extends AnySchema>(
  config: ScenarioServerConfig<TSchema>,
): config is Extract<ScenarioServerConfig<TSchema>, { fragment: AnyFragnoInstantiatedFragment }> =>
  "fragment" in config;

export const runScenario = async <
  TSchema extends AnySchema,
  TCommandContext = unknown,
  TCommands extends ReadonlyArray<LofiSubmitCommandDefinition> =
    ReadonlyArray<LofiSubmitCommandDefinition>,
  TVars extends ScenarioVars = ScenarioVars,
>(
  scenario: ScenarioDefinition<TSchema, TCommandContext, TCommands, TVars>,
  options?: RunScenarioOptions,
): Promise<ScenarioContext<TSchema, TCommandContext, TVars>> => {
  let adapter: InMemoryAdapter | undefined;
  let fragment: ScenarioFragment;

  const restoreGlobals = installIndexedDbGlobals(options?.indexedDbGlobals);

  if (isScenarioDefinitionConfig(scenario.server)) {
    adapter = new InMemoryAdapter({ idSeed: `lofi-scenario-${scenario.name}` });
    const fragmentDef = defineFragment(scenario.server.fragmentName)
      .extend(withDatabase(scenario.server.schema))
      .withSyncCommands(scenario.server.syncCommands)
      .build();

    fragment = instantiate(fragmentDef)
      .withConfig({})
      .withRoutes([])
      .withOptions({ databaseAdapter: adapter, outbox: { enabled: true } })
      .build() as unknown as ScenarioFragment;
  } else if (isScenarioFragmentConfig(scenario.server)) {
    fragment = scenario.server.fragment as unknown as ScenarioFragment;
  } else {
    throw new Error("Scenario server must include fragment configuration.");
  }

  const shouldStartServer = typeof scenario.server.port === "number";
  const cleanupCallbacks: Array<() => void> = [];
  const baseUrlOverride = scenario.server.baseUrl;
  let fetcher: typeof fetch = createServerFetch(fragment);
  let baseUrl = baseUrlOverride ?? "http://lofi-scenario.test";
  let closeServer: (() => Promise<void>) | undefined;

  if (shouldStartServer) {
    const { baseUrl: serverUrl, close } = await startScenarioServer(
      fragment,
      scenario.server.port!,
    );
    const mountRoute = resolveMountRoute(fragment);
    baseUrl = baseUrlOverride ?? `${serverUrl}${mountRoute ?? ""}`;
    fetcher = fetch.bind(globalThis);
    closeServer = close;
  }

  const context: ScenarioContext<TSchema, TCommandContext, TVars> = {
    name: scenario.name,
    server: {
      adapter,
      fragment,
      baseUrl,
    },
    clients: {},
    vars: {},
    lastSubmit: {},
    lastSync: {},
    lastBootstrap: {},
    cleanup: async () => {
      for (const cleanup of cleanupCallbacks.splice(0).reverse()) {
        cleanup();
      }
      for (const client of Object.values(context.clients)) {
        client.runtime.stop();
      }
      if (closeServer) {
        await closeServer();
      }
      if (adapter) {
        await adapter.close();
      }
      if (restoreGlobals) {
        restoreGlobals();
      }
    },
  };
  try {
    const clientCommands = Array.from(scenario.clientCommands) as Array<
      LofiSubmitCommandDefinition<unknown, TCommandContext>
    >;
    const schema = scenario.server.schema;
    const localSchemas = scenario.localSchemas ?? [];
    const localSchemaRegistrations = localSchemas.map((localSchema) => ({ schema: localSchema }));
    const projections = scenario.localProjections ?? [];

    for (const [name, clientConfig] of Object.entries(scenario.clients)) {
      const dbName = `lofi-scenario-${scenario.name}-${name}-${Math.random().toString(16).slice(2)}`;
      const createClientContext = scenario.createClientContext;
      const createCommandContext = createClientContext
        ? (_command: LofiSubmitCommandDefinition<unknown, TCommandContext>) =>
            createClientContext(name)
        : undefined;
      const adapterConfig = clientConfig.adapter;
      const clientFetch =
        clientConfig.fetch?.({
          baseFetch: fetcher,
          baseUrl,
          clientName: name,
        }) ?? fetcher;

      const adapters: ScenarioClientAdapters<TCommandContext> = (() => {
        if (!adapterConfig || adapterConfig.type === "indexeddb") {
          const baseAdapter = new IndexedDbAdapter({
            dbName: adapterConfig?.dbName ?? dbName,
            endpointName: clientConfig.endpointName,
            schemas: [{ schema }],
            localSchemas: localSchemaRegistrations,
            projections,
          });
          return {
            adapter: baseAdapter,
            baseAdapter,
          };
        }

        if (adapterConfig.type === "in-memory") {
          const baseAdapter = new InMemoryLofiAdapter({
            endpointName: clientConfig.endpointName,
            schemas: [schema],
            localSchemas,
            projections,
            ...(adapterConfig.store ? { store: adapterConfig.store } : {}),
          });
          return {
            adapter: baseAdapter,
            baseAdapter,
            baseStore: baseAdapter.store,
          };
        }

        if (adapterConfig.type === "stacked") {
          const baseKind = adapterConfig.base ?? "indexeddb";
          const baseAdapter =
            baseKind === "in-memory"
              ? new InMemoryLofiAdapter({
                  endpointName: clientConfig.endpointName,
                  schemas: [schema],
                  localSchemas,
                  projections,
                  ...(adapterConfig.baseStore ? { store: adapterConfig.baseStore } : {}),
                })
              : new IndexedDbAdapter({
                  dbName: adapterConfig.baseDbName ?? dbName,
                  endpointName: clientConfig.endpointName,
                  schemas: [{ schema }],
                  localSchemas: localSchemaRegistrations,
                  projections,
                });

          const overlayManager = new LofiOverlayManager({
            endpointName: clientConfig.endpointName,
            adapter: baseAdapter,
            schemas: [schema],
            localSchemas,
            projections,
            commands: clientCommands,
            ...(createCommandContext ? { createCommandContext } : {}),
            ...(adapterConfig.overlayStore ? { store: adapterConfig.overlayStore } : {}),
          });

          return {
            adapter: overlayManager.stackedAdapter,
            baseAdapter,
            overlayAdapter: overlayManager.overlayAdapter,
            stackedAdapter: overlayManager.stackedAdapter,
            overlayManager,
            baseStore: baseAdapter instanceof InMemoryLofiAdapter ? baseAdapter.store : undefined,
            overlayStore: overlayManager.store,
          };
        }

        const _exhaustive: never = adapterConfig;
        throw new Error(`Unsupported scenario adapter config: ${String(_exhaustive)}`);
      })();

      const submit = new LofiSubmitClient<TCommandContext>({
        endpointName: clientConfig.endpointName,
        submitUrl: `${baseUrl}/_internal/sync`,
        internalUrl: `${baseUrl}/_internal`,
        adapter: adapters.adapter,
        schemas: [schema],
        commands: clientCommands,
        fetch: clientFetch,
        ...(createCommandContext ? { createCommandContext } : {}),
        ...(adapters.overlayManager ? { overlay: adapters.overlayManager } : {}),
      });

      const sync = new LofiClient({
        endpointName: clientConfig.endpointName,
        outboxUrl: `${baseUrl}/_internal/outbox`,
        adapter: adapters.adapter,
        fetch: clientFetch,
      });
      const runtimeSources = (clientConfig.sources ?? [{ id: "default" }]).map((source) => ({
        id: source.id,
        outboxUrl: resolveScenarioOutboxUrl(source, baseUrl),
        cursorKey: source.cursorKey,
        pollIntervalMs: source.pollIntervalMs,
      }));
      const runtime = createLofiRuntime({
        endpointName: clientConfig.endpointName,
        adapter: adapters.adapter,
        sources: runtimeSources,
        fetch: clientFetch,
        bootstrap: clientConfig.bootstrap,
      });

      const queryAdapter = adapters.stackedAdapter ?? adapters.baseAdapter;
      const createQueryEngine = <const T extends AnySchema>(querySchema: T) =>
        queryAdapter.createQueryEngine(querySchema);

      context.clients[name] = {
        name,
        endpointName: clientConfig.endpointName,
        adapter: adapters.adapter,
        submit,
        sync,
        runtime,
        query: createQueryEngine(schema),
        baseQuery: adapters.baseAdapter.createQueryEngine(schema),
        overlayQuery: adapters.overlayAdapter
          ? adapters.overlayAdapter.createQueryEngine(schema)
          : undefined,
        createQueryEngine,
        adapters: {
          base: adapters.baseAdapter,
          overlay: adapters.overlayAdapter,
          stacked: adapters.stackedAdapter,
        },
        stores: {
          base: adapters.baseStore,
          overlay: adapters.overlayStore,
          reactive: {},
          serverRendered: {},
          pendingReactive: {},
        },
        storeProbes: {},
        overlayManager: adapters.overlayManager,
      };
    }

    for (const step of scenario.steps) {
      if (step.type === "assert") {
        await step.assert(context);
        continue;
      }

      const client = context.clients[step.client];
      if (!client) {
        throw new Error(`Unknown scenario client: ${step.client}`);
      }

      if (step.type === "command") {
        const input = await resolveScenarioResolvableValue(step.input, context);
        const target = step.target ?? resolveCommandTarget(step.name, clientCommands) ?? null;
        if (!target) {
          throw new Error(`Unknown scenario command target: ${step.name}`);
        }

        const commandId = await client.submit.queueCommand({
          name: step.name,
          target,
          input,
          optimistic: step.optimistic,
        });

        if (step.storeCommandIdAs !== undefined) {
          context.vars[step.storeCommandIdAs] = commandId as TVars[KeysMatching<TVars, string> &
            string];
        }

        if (step.submit) {
          context.lastSubmit[step.client] = await client.submit.submitOnce();
        }

        continue;
      }

      if (step.type === "submit") {
        context.lastSubmit[step.client] = await client.submit.submitOnce();
        continue;
      }

      if (step.type === "sync") {
        context.lastSync[step.client] = await client.runtime.syncOnce(step.sourceId);
        continue;
      }

      if (step.type === "bootstrap") {
        context.lastBootstrap[step.client] = await client.runtime.bootstrap(step.sourceId);
        continue;
      }

      if (step.type === "waitForBootstrap") {
        await waitForScenarioBootstrap(client, step.timeoutMs);
        continue;
      }

      if (step.type === "read") {
        const result = await resolveReadResult(step.read, context, client);
        if (step.storeAs !== undefined) {
          context.vars[step.storeAs] = result as TVars[keyof TVars];
        }
        continue;
      }

      if (step.type === "createStore") {
        const initialData = await resolveScenarioResolvableValue(step.initialData, context);
        const storeOptions = step.map
          ? {
              initialData,
              map: (rows: unknown) => step.map?.(rows, context),
            }
          : { initialData };
        client.stores.serverRendered ??= {};
        client.stores.serverRendered[step.name] = {
          data: initialData,
          loading: false,
          error: null,
          synced: false,
        };
        client.stores.pendingReactive ??= {};
        client.stores.pendingReactive[step.name] = {
          schema: step.schema ?? schema,
          table: step.table as keyof TSchema["tables"] & string,
          query: step.query,
          storeOptions: storeOptions as ScenarioPendingReactiveStore<TSchema>["storeOptions"],
        };
        if (step.mount ?? true) {
          mountScenarioReactiveStore(client, schema, step.name, cleanupCallbacks);
        }
        continue;
      }

      if (step.type === "readStore") {
        const store = client.stores.reactive?.[step.name];
        const state = store?.get() ?? client.stores.serverRendered?.[step.name];
        if (!state) {
          throw new Error(`Unknown scenario store: ${client.name}.${step.name}`);
        }
        context.vars[step.storeAs] = state.data as TVars[keyof TVars];
        continue;
      }

      if (step.type === "readStoreState") {
        const store = client.stores.reactive?.[step.name];
        const state = store?.get() ?? client.stores.serverRendered?.[step.name];
        if (!state) {
          throw new Error(`Unknown scenario store: ${client.name}.${step.name}`);
        }
        context.vars[step.storeAs] = state as TVars[keyof TVars];
        continue;
      }

      if (step.type === "mountStore") {
        mountScenarioReactiveStore(client, schema, step.name, cleanupCallbacks);
        continue;
      }

      if (step.type === "waitForStore") {
        await waitForScenarioStore(
          getScenarioReactiveStore(client, step.name),
          step.predicate,
          step.timeoutMs,
        );
        continue;
      }

      if (step.type === "assertStoreEmissions") {
        const probe = client.storeProbes[step.name];
        if (!probe) {
          throw new Error(`Unknown scenario store probe: ${client.name}.${step.name}`);
        }
        await step.assert(probe.values);
        continue;
      }
    }

    return context;
  } catch (error) {
    await context.cleanup();
    throw error;
  }
};
