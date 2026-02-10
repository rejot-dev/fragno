import { defineFragment, instantiate } from "@fragno-dev/core";
import { InMemoryAdapter, withDatabase, type SyncCommandRegistry } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";
import { LofiClient } from "../client/client";
import { LofiSubmitClient } from "../submit/client";
import type { LofiSubmitCommandDefinition, LofiSubmitResponse, LofiSyncResult } from "../types";
import { IndexedDbAdapter } from "../indexeddb/adapter";

export type ScenarioServerConfig = {
  fragmentName: string;
  schema: AnySchema;
  syncCommands: SyncCommandRegistry;
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
  callRouteRaw: (method: HTTPMethod, path: string, inputOptions?: unknown) => Promise<Response>;
};

export type ScenarioContext = {
  name: string;
  server: {
    adapter: InMemoryAdapter;
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
      optimistic?: boolean;
      submit?: boolean;
      storeCommandIdAs?: string;
    },
  ): ScenarioCommandStep => ({
    type: "command",
    client,
    name,
    input,
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

export const runScenario = async (scenario: ScenarioDefinition): Promise<ScenarioContext> => {
  const adapter = new InMemoryAdapter({ idSeed: `lofi-scenario-${scenario.name}` });
  const fragmentDef = defineFragment(scenario.server.fragmentName)
    .extend(withDatabase(scenario.server.schema))
    .withSyncCommands(scenario.server.syncCommands)
    .build();

  const fragment = instantiate(fragmentDef)
    .withConfig({})
    .withRoutes([])
    .withOptions({ databaseAdapter: adapter, outbox: { enabled: true } })
    .build();
  const serverFragment = fragment as unknown as ScenarioFragment;

  const baseUrl = "http://lofi-scenario.test";
  const fetcher = createServerFetch(serverFragment);

  const context: ScenarioContext = {
    name: scenario.name,
    server: {
      adapter,
      fragment: serverFragment,
      baseUrl,
    },
    clients: {},
    vars: {},
    lastSubmit: {},
    lastSync: {},
    cleanup: async () => {
      await adapter.close();
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
      const commandId = await client.submit.queueCommand({
        name: step.name,
        target: {
          fragment: scenario.server.fragmentName,
          schema: scenario.server.schema.name,
        },
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
