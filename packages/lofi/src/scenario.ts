import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { defineFragment, instantiate, type AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import { toNodeHandler } from "@fragno-dev/node";
import { InMemoryAdapter, withDatabase, type SyncCommandRegistry } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";
import { LofiClient } from "./client/client";
import { LofiSubmitClient } from "./submit/client";
import type {
  LofiSubmitCommandDefinition,
  LofiSubmitCommandTarget,
  LofiSubmitResponse,
  LofiSyncResult,
} from "./types";
import { IndexedDbAdapter } from "./indexeddb/adapter";

export type ScenarioServerConfig =
  | {
      fragmentName: string;
      schema: AnySchema;
      syncCommands: SyncCommandRegistry;
      port?: number;
      baseUrl?: string;
    }
  | {
      fragment: AnyFragnoInstantiatedFragment;
      schema: AnySchema;
      port?: number;
      baseUrl?: string;
    };

export type ScenarioClientConfig = {
  endpointName: string;
};

export type ScenarioDefinition = {
  name: string;
  server: ScenarioServerConfig;
  clientCommands: LofiSubmitCommandDefinition[];
  clients: Record<string, ScenarioClientConfig>;
  steps: ScenarioStep[];
  createClientContext?: (clientName: string) => unknown;
};

type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

type ScenarioFragment = {
  handler: (req: Request) => Promise<Response>;
  callRouteRaw: (method: HTTPMethod, path: string, inputOptions?: unknown) => Promise<Response>;
};

export type ScenarioContext = {
  name: string;
  server: {
    adapter?: InMemoryAdapter;
    fragment: ScenarioFragment;
    baseUrl: string;
  };
  clients: Record<string, ScenarioClient>;
  vars: Record<string, unknown>;
  lastSubmit: Record<string, LofiSubmitResponse | undefined>;
  lastSync: Record<string, LofiSyncResult | undefined>;
  cleanup: () => Promise<void>;
};

export type ScenarioClient = {
  name: string;
  endpointName: string;
  adapter: IndexedDbAdapter;
  submit: LofiSubmitClient<unknown>;
  sync: LofiClient;
  query: unknown;
};

type CommandInput = unknown | ((ctx: ScenarioContext) => unknown | Promise<unknown>);
type ReadFn<T = unknown> =
  | ((ctx: ScenarioContext) => T | Promise<T>)
  | ((ctx: ScenarioContext, client: ScenarioClient) => T | Promise<T>);

export type ScenarioCommandStep = {
  type: "command";
  client: string;
  name: string;
  input: CommandInput;
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

export type ScenarioReadStep = {
  type: "read";
  client: string;
  read: ReadFn;
  storeAs?: string;
};

export type ScenarioAssertStep = {
  type: "assert";
  assert: (ctx: ScenarioContext) => void | Promise<void>;
};

export type ScenarioWaitStep = {
  type: "wait";
  ms: number;
};

export type ScenarioStep =
  | ScenarioCommandStep
  | ScenarioSubmitStep
  | ScenarioSyncStep
  | ScenarioReadStep
  | ScenarioAssertStep
  | ScenarioWaitStep;

export const defineScenario = <T extends ScenarioDefinition>(scenario: T): T => scenario;

export const steps = {
  command: (
    client: string,
    name: string,
    input: CommandInput,
    options?: {
      target?: LofiSubmitCommandTarget;
      optimistic?: boolean;
      submit?: boolean;
      storeCommandIdAs?: string;
    },
  ): ScenarioCommandStep => ({
    type: "command",
    client,
    name,
    input,
    target: options?.target,
    optimistic: options?.optimistic,
    submit: options?.submit,
    storeCommandIdAs: options?.storeCommandIdAs,
  }),
  submit: (client: string): ScenarioSubmitStep => ({ type: "submit", client }),
  sync: (client: string): ScenarioSyncStep => ({ type: "sync", client }),
  read: (client: string, read: ReadFn, storeAs?: string): ScenarioReadStep => ({
    type: "read",
    client,
    read,
    storeAs,
  }),
  assert: (assert: ScenarioAssertStep["assert"]): ScenarioAssertStep => ({
    type: "assert",
    assert,
  }),
  wait: (ms: number): ScenarioWaitStep => ({ type: "wait", ms }),
};

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

const resolveCommandInput = async (input: CommandInput, ctx: ScenarioContext): Promise<unknown> => {
  if (typeof input === "function") {
    return await input(ctx);
  }
  return input;
};

const resolveReadResult = async (read: ReadFn, ctx: ScenarioContext, client: ScenarioClient) => {
  if (read.length >= 2) {
    return await (read as (ctx: ScenarioContext, client: ScenarioClient) => unknown)(ctx, client);
  }
  return await (read as (ctx: ScenarioContext) => unknown)(ctx);
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

const resolveCommandTarget = (
  commandName: string,
  commands: LofiSubmitCommandDefinition[],
): LofiSubmitCommandTarget | undefined => {
  for (const command of commands) {
    if (command.name === commandName) {
      return command.target;
    }
  }
  return undefined;
};

const isScenarioDefinitionConfig = (
  config: ScenarioServerConfig,
): config is Extract<
  ScenarioServerConfig,
  { fragmentName: string; schema: AnySchema; syncCommands: SyncCommandRegistry }
> => "fragmentName" in config;

const isScenarioFragmentConfig = (
  config: ScenarioServerConfig,
): config is Extract<ScenarioServerConfig, { fragment: AnyFragnoInstantiatedFragment }> =>
  "fragment" in config;

export const runScenario = async (scenario: ScenarioDefinition): Promise<ScenarioContext> => {
  let adapter: InMemoryAdapter | undefined;
  let fragment: ScenarioFragment;

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

  const context: ScenarioContext = {
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
    },
  };

  for (const [name, clientConfig] of Object.entries(scenario.clients)) {
    const dbName = `lofi-scenario-${scenario.name}-${name}-${Math.random().toString(16).slice(2)}`;
    const adapter = new IndexedDbAdapter({
      dbName,
      endpointName: clientConfig.endpointName,
      schemas: [{ schema: scenario.server.schema }],
    });

    const createCommandContext = scenario.createClientContext
      ? () => scenario.createClientContext?.(name)
      : undefined;

    const submit = new LofiSubmitClient({
      endpointName: clientConfig.endpointName,
      submitUrl: `${baseUrl}/_internal/sync`,
      internalUrl: `${baseUrl}/_internal`,
      adapter,
      schemas: [scenario.server.schema],
      commands: scenario.clientCommands,
      fetch: fetcher,
      ...(createCommandContext ? { createCommandContext } : {}),
    });

    const sync = new LofiClient({
      endpointName: clientConfig.endpointName,
      outboxUrl: `${baseUrl}/_internal/outbox`,
      adapter,
      fetch: fetcher,
    });

    context.clients[name] = {
      name,
      endpointName: clientConfig.endpointName,
      adapter,
      submit,
      sync,
      query: adapter.createQueryEngine(scenario.server.schema),
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
      const target =
        step.target ?? resolveCommandTarget(step.name, scenario.clientCommands) ?? null;
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
