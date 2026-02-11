import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { defineFragment, instantiate, type AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import { toNodeHandler } from "@fragno-dev/node";
import { InMemoryAdapter, withDatabase, type SyncCommandRegistry } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";
import { LofiClient } from "./client/client";
import { LofiSubmitClient } from "./submit/client";
import type {
  LofiAdapter,
  LofiQueryInterface,
  LofiQueryableAdapter,
  LofiSubmitCommandDefinition,
  LofiSubmitCommandTarget,
  LofiSubmitResponse,
  LofiSyncResult,
} from "./types";
import { IndexedDbAdapter } from "./indexeddb/adapter";
import { InMemoryLofiAdapter } from "./adapters/in-memory/adapter";
import { StackedLofiAdapter } from "./adapters/stacked/adapter";
import { LofiOverlayManager } from "./optimistic/overlay-manager";
import type { InMemoryLofiStore } from "./adapters/in-memory/store";

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

export type ScenarioClientConfig = {
  endpointName: string;
  adapter?: ScenarioClientAdapterConfig;
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
  TCommands extends
    ReadonlyArray<LofiSubmitCommandDefinition> = ReadonlyArray<LofiSubmitCommandDefinition>,
> = {
  name: string;
  server: ScenarioServerConfig<TSchema>;
  clientCommands: TCommands;
  clients: Record<string, ScenarioClientConfig>;
  steps: ScenarioStep<NoInfer<TSchema>, NoInfer<TCommandContext>>[];
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

export type ScenarioContext<TSchema extends AnySchema = AnySchema, TCommandContext = unknown> = {
  name: string;
  server: {
    adapter?: InMemoryAdapter;
    fragment: ScenarioFragment;
    baseUrl: string;
  };
  clients: Record<string, ScenarioClient<TSchema, TCommandContext>>;
  vars: Record<string, unknown>;
  lastSubmit: Record<string, LofiSubmitResponse | undefined>;
  lastSync: Record<string, LofiSyncResult | undefined>;
  cleanup: () => Promise<void>;
};

export type ScenarioClient<TSchema extends AnySchema = AnySchema, TCommandContext = unknown> = {
  name: string;
  endpointName: string;
  adapter: LofiAdapter & LofiQueryableAdapter;
  submit: LofiSubmitClient<TCommandContext>;
  sync: LofiClient;
  query: LofiQueryInterface<TSchema>;
  baseQuery: LofiQueryInterface<TSchema>;
  overlayQuery?: LofiQueryInterface<TSchema>;
  adapters: {
    base: LofiAdapter & LofiQueryableAdapter;
    overlay?: InMemoryLofiAdapter;
    stacked?: StackedLofiAdapter;
  };
  stores: {
    base?: InMemoryLofiStore;
    overlay?: InMemoryLofiStore;
  };
  overlayManager?: LofiOverlayManager<TCommandContext>;
};

type CommandInput<TSchema extends AnySchema = AnySchema, TCommandContext = unknown> =
  | unknown
  | CommandInputFn<TSchema, TCommandContext>;
type CommandInputFn<TSchema extends AnySchema = AnySchema, TCommandContext = unknown> = (
  ctx: ScenarioContext<TSchema, TCommandContext>,
) => unknown | Promise<unknown>;
type ReadFn<TSchema extends AnySchema = AnySchema, TCommandContext = unknown, T = unknown> =
  | BivariantCallback<(ctx: ScenarioContext<TSchema, TCommandContext>) => T | Promise<T>>
  | BivariantCallback<
      (
        ctx: ScenarioContext<TSchema, TCommandContext>,
        client: ScenarioClient<TSchema, TCommandContext>,
      ) => T | Promise<T>
    >;

export type ScenarioCommandStep<
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
> = {
  type: "command";
  client: string;
  name: string;
  input: CommandInput<TSchema, TCommandContext>;
  target?: LofiSubmitCommandTarget;
  optimistic?: boolean;
  submit?: boolean;
  storeCommandIdAs?: string;
};

export type ScenarioSubmitStep = {
  type: "submit";
  client: string;
};

export type ScenarioSyncStep = {
  type: "sync";
  client: string;
};

export type ScenarioReadStep<TSchema extends AnySchema = AnySchema, TCommandContext = unknown> = {
  type: "read";
  client: string;
  read: ReadFn<TSchema, TCommandContext>;
  storeAs?: string;
};

export type ScenarioAssertStep<TSchema extends AnySchema = AnySchema, TCommandContext = unknown> = {
  type: "assert";
  assert: BivariantCallback<
    (ctx: ScenarioContext<TSchema, TCommandContext>) => void | Promise<void>
  >;
};

export type ScenarioWaitStep = {
  type: "wait";
  ms: number;
};

export type ScenarioStep<TSchema extends AnySchema = AnySchema, TCommandContext = unknown> =
  | ScenarioCommandStep<TSchema, TCommandContext>
  | ScenarioSubmitStep
  | ScenarioSyncStep
  | ScenarioReadStep<TSchema, TCommandContext>
  | ScenarioAssertStep<TSchema, TCommandContext>
  | ScenarioWaitStep;

export function defineScenario<
  TSchema extends AnySchema,
  TCommandContext,
  TCommands extends
    ReadonlyArray<LofiSubmitCommandDefinition> = ReadonlyArray<LofiSubmitCommandDefinition>,
>(
  scenario: ScenarioDefinition<TSchema, TCommandContext, TCommands> & {
    createClientContext: (clientName: string) => TCommandContext;
  },
): ScenarioDefinition<TSchema, TCommandContext, TCommands>;
export function defineScenario<
  TSchema extends AnySchema,
  TCommandContext = unknown,
  TCommands extends
    ReadonlyArray<LofiSubmitCommandDefinition> = ReadonlyArray<LofiSubmitCommandDefinition>,
>(
  scenario: ScenarioDefinition<TSchema, TCommandContext, TCommands>,
): ScenarioDefinition<TSchema, TCommandContext, TCommands>;
export function defineScenario(scenario: ScenarioDefinition): ScenarioDefinition {
  return scenario;
}

function command<TSchema extends AnySchema = AnySchema, TCommandContext = unknown>(
  client: string,
  name: string,
  input: CommandInputFn<TSchema, TCommandContext>,
  options?: {
    target?: LofiSubmitCommandTarget;
    optimistic?: boolean;
    submit?: boolean;
    storeCommandIdAs?: string;
  },
): ScenarioCommandStep<TSchema, TCommandContext>;
function command<TSchema extends AnySchema = AnySchema, TCommandContext = unknown>(
  client: string,
  name: string,
  input: unknown,
  options?: {
    target?: LofiSubmitCommandTarget;
    optimistic?: boolean;
    submit?: boolean;
    storeCommandIdAs?: string;
  },
): ScenarioCommandStep<TSchema, TCommandContext>;
function command<TSchema extends AnySchema = AnySchema, TCommandContext = unknown>(
  client: string,
  name: string,
  input: CommandInput<TSchema, TCommandContext>,
  options?: {
    target?: LofiSubmitCommandTarget;
    optimistic?: boolean;
    submit?: boolean;
    storeCommandIdAs?: string;
  },
): ScenarioCommandStep<TSchema, TCommandContext> {
  return {
    type: "command",
    client,
    name,
    input,
    target: options?.target,
    optimistic: options?.optimistic,
    submit: options?.submit,
    storeCommandIdAs: options?.storeCommandIdAs,
  };
}

const submit = (client: string): ScenarioSubmitStep => ({ type: "submit", client });
const sync = (client: string): ScenarioSyncStep => ({ type: "sync", client });
function read<TSchema extends AnySchema = AnySchema, TCommandContext = unknown>(
  client: string,
  read: ReadFn<TSchema, TCommandContext>,
  storeAs?: string,
): ScenarioReadStep<TSchema, TCommandContext> {
  return {
    type: "read",
    client,
    read,
    storeAs,
  };
}
function assert<TSchema extends AnySchema = AnySchema, TCommandContext = unknown>(
  assert: ScenarioAssertStep<TSchema, TCommandContext>["assert"],
): ScenarioAssertStep<TSchema, TCommandContext> {
  return {
    type: "assert",
    assert,
  };
}
const wait = (ms: number): ScenarioWaitStep => ({ type: "wait", ms });

export const createScenarioSteps = <
  TSchema extends AnySchema = AnySchema,
  TCommandContext = unknown,
>() => ({
  command: (() => {
    function commandStep(
      client: string,
      name: string,
      input: CommandInputFn<TSchema, TCommandContext>,
      options?: {
        target?: LofiSubmitCommandTarget;
        optimistic?: boolean;
        submit?: boolean;
        storeCommandIdAs?: string;
      },
    ): ScenarioCommandStep<TSchema, TCommandContext>;
    function commandStep(
      client: string,
      name: string,
      input: unknown,
      options?: {
        target?: LofiSubmitCommandTarget;
        optimistic?: boolean;
        submit?: boolean;
        storeCommandIdAs?: string;
      },
    ): ScenarioCommandStep<TSchema, TCommandContext>;
    function commandStep(
      client: string,
      name: string,
      input: CommandInput<TSchema, TCommandContext>,
      options?: {
        target?: LofiSubmitCommandTarget;
        optimistic?: boolean;
        submit?: boolean;
        storeCommandIdAs?: string;
      },
    ): ScenarioCommandStep<TSchema, TCommandContext> {
      return command<TSchema, TCommandContext>(client, name, input, options);
    }
    return commandStep;
  })(),
  submit,
  sync,
  read: (client: string, readFn: ReadFn<TSchema, TCommandContext>, storeAs?: string) =>
    read<TSchema, TCommandContext>(client, readFn, storeAs),
  assert: (assertFn: ScenarioAssertStep<TSchema, TCommandContext>["assert"]) =>
    assert<TSchema, TCommandContext>(assertFn),
  wait,
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

const resolveCommandInput = async <TSchema extends AnySchema, TCommandContext>(
  input: CommandInput<TSchema, TCommandContext>,
  ctx: ScenarioContext<TSchema, TCommandContext>,
): Promise<unknown> => {
  if (typeof input === "function") {
    return await input(ctx);
  }
  return input;
};

const resolveReadResult = async <TSchema extends AnySchema, TCommandContext, T = unknown>(
  read: ReadFn<TSchema, TCommandContext, T>,
  ctx: ScenarioContext<TSchema, TCommandContext>,
  client: ScenarioClient<TSchema, TCommandContext>,
): Promise<T> => {
  if (read.length >= 2) {
    return await (
      read as (
        ctx: ScenarioContext<TSchema, TCommandContext>,
        client: ScenarioClient<TSchema, TCommandContext>,
      ) => T
    )(ctx, client);
  }
  return await (read as (ctx: ScenarioContext<TSchema, TCommandContext>) => T)(ctx);
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
  TCommands extends
    ReadonlyArray<LofiSubmitCommandDefinition> = ReadonlyArray<LofiSubmitCommandDefinition>,
>(
  scenario: ScenarioDefinition<TSchema, TCommandContext, TCommands>,
  options?: RunScenarioOptions,
): Promise<ScenarioContext<TSchema, TCommandContext>> => {
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
  const baseUrlOverride = scenario.server.baseUrl;
  let fetcher: typeof fetch = createServerFetch(fragment);
  let baseUrl = baseUrlOverride ?? "http://lofi-scenario.test";
  let closeServer: (() => Promise<void>) | undefined;

  if (shouldStartServer) {
    const { baseUrl: serverUrl, close } = await startScenarioServer(
      fragment,
      scenario.server.port as number,
    );
    const mountRoute = resolveMountRoute(fragment);
    baseUrl = baseUrlOverride ?? `${serverUrl}${mountRoute ?? ""}`;
    fetcher = fetch.bind(globalThis);
    closeServer = close;
  }

  const context: ScenarioContext<TSchema, TCommandContext> = {
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
    cleanup: async () => {
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
  const clientCommands = Array.from(scenario.clientCommands) as Array<
    LofiSubmitCommandDefinition<unknown, TCommandContext>
  >;

  for (const [name, clientConfig] of Object.entries(scenario.clients)) {
    const dbName = `lofi-scenario-${scenario.name}-${name}-${Math.random().toString(16).slice(2)}`;
    const createClientContext = scenario.createClientContext;
    const createCommandContext = createClientContext
      ? (_command: LofiSubmitCommandDefinition<unknown, TCommandContext>) =>
          createClientContext(name)
      : undefined;
    const adapterConfig = clientConfig.adapter;
    const schema = scenario.server.schema;

    const adapters: ScenarioClientAdapters<TCommandContext> = (() => {
      if (!adapterConfig || adapterConfig.type === "indexeddb") {
        const baseAdapter = new IndexedDbAdapter({
          dbName: adapterConfig?.dbName ?? dbName,
          endpointName: clientConfig.endpointName,
          schemas: [{ schema }],
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
                ...(adapterConfig.baseStore ? { store: adapterConfig.baseStore } : {}),
              })
            : new IndexedDbAdapter({
                dbName: adapterConfig.baseDbName ?? dbName,
                endpointName: clientConfig.endpointName,
                schemas: [{ schema }],
              });

        const overlayManager = new LofiOverlayManager({
          endpointName: clientConfig.endpointName,
          adapter: baseAdapter,
          schemas: [schema],
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
      fetch: fetcher,
      ...(createCommandContext ? { createCommandContext } : {}),
      ...(adapters.overlayManager ? { overlay: adapters.overlayManager } : {}),
    });

    const sync = new LofiClient({
      endpointName: clientConfig.endpointName,
      outboxUrl: `${baseUrl}/_internal/outbox`,
      adapter: adapters.adapter,
      fetch: fetcher,
    });

    const queryAdapter = adapters.stackedAdapter ?? adapters.baseAdapter;

    context.clients[name] = {
      name,
      endpointName: clientConfig.endpointName,
      adapter: adapters.adapter,
      submit,
      sync,
      query: queryAdapter.createQueryEngine(schema),
      baseQuery: adapters.baseAdapter.createQueryEngine(schema),
      overlayQuery: adapters.overlayAdapter
        ? adapters.overlayAdapter.createQueryEngine(schema)
        : undefined,
      adapters: {
        base: adapters.baseAdapter,
        overlay: adapters.overlayAdapter,
        stacked: adapters.stackedAdapter,
      },
      stores: {
        base: adapters.baseStore,
        overlay: adapters.overlayStore,
      },
      overlayManager: adapters.overlayManager,
    };
  }

  for (const step of scenario.steps) {
    if (step.type === "wait") {
      await new Promise((resolve) => setTimeout(resolve, step.ms));
      continue;
    }

    if (step.type === "assert") {
      await step.assert(context);
      continue;
    }

    const client = context.clients[step.client];
    if (!client) {
      throw new Error(`Unknown scenario client: ${step.client}`);
    }

    if (step.type === "command") {
      const input = await resolveCommandInput(step.input, context);
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

      if (step.storeCommandIdAs) {
        context.vars[step.storeCommandIdAs] = commandId;
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
      context.lastSync[step.client] = await client.sync.syncOnce();
      continue;
    }

    if (step.type === "read") {
      const result = await resolveReadResult(step.read, context, client);
      if (step.storeAs) {
        context.vars[step.storeAs] = result;
      }
      continue;
    }
  }

  return context;
};
