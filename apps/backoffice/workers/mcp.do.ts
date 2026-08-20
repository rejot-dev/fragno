import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { McpObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import { createDurableHookRepository } from "@/fragno/durable-hooks";
import { createMcpServer, type McpConfig, type McpFragment } from "@/fragno/mcp";
import { MCP_PUBLIC_PREFIX, scopedPublicBaseUrl } from "@/fragno/scoped-public-fragment-routes";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import { cloudflareDurableHooksInstrumentation } from "./lib/cloudflare-durable-hooks-instrumentation";
import {
  createScopedFragmentDurableObjectRuntime,
  type ScopedFragmentDurableObjectRuntime,
} from "./lib/scoped-fragment-durable-object";

type McpObjectEnv = {
  DOCS_PUBLIC_BASE_URL?: string;
};

function readMcpPublicOrigin(env: McpObjectEnv) {
  const origin = env.DOCS_PUBLIC_BASE_URL?.trim();
  if (!origin) {
    throw new Error("MCP OAuth redirect origin is not configured.");
  }
  return origin;
}

function scopeSubject(scope: BackofficeRoutableScope, serverId?: string) {
  return {
    scope,
    ...(scope.kind === "org" || scope.kind === "project" ? { orgId: scope.orgId } : {}),
    ...(serverId ? { serverId } : {}),
  };
}

export class InMemoryMcpObject extends RpcTarget implements McpObject {
  readonly #env: McpObjectEnv;
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #host: FragmentDurableObjectHost<McpConfig, McpFragment>;
  readonly #scopedRuntime: ScopedFragmentDurableObjectRuntime<McpFragment>;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env?: McpObjectEnv;
    runtime: BackofficeRuntimeServices;
  }) {
    super();
    this.#env = env ?? {};
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#host = createFragmentDurableObjectHost({
      name: "MCP",
      state,
      env: this.#env,
      createRuntime: (config) =>
        createMcpServer(config, {
          adapters: this.#runtimeServices.adapters,
        }),
      durableHooksInstrumentation: cloudflareDurableHooksInstrumentation,
      onProcessError: (error) => {
        console.error("MCP hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("MCP hook processor disabled", error);
      },
    });
    this.#scopedRuntime = createScopedFragmentDurableObjectRuntime({
      name: "MCP",
      state,
      host: this.#host,
      createSource: (scope) => this.#createConfig(scope),
    });

    void state.blockConcurrencyWhile(async () => {
      // Restore inside the constructor boundary so alarms cannot run before the dispatcher exists.
      await this.#scopedRuntime.initializeFromStoredOwnerScope();
    });
  }

  init(scope: BackofficeContextScope): McpObject {
    this.#scopedRuntime.init(scope);
    return this;
  }

  async getPublicBaseUrl(): Promise<string> {
    return scopedPublicBaseUrl({
      baseUrl: readMcpPublicOrigin(this.#env),
      publicPrefix: MCP_PUBLIC_PREFIX,
      scope: this.#scopedRuntime.requireOwnerScope(),
    });
  }

  #createConfig(ownerScope: BackofficeRoutableScope): McpConfig {
    return {
      publicBaseUrl: scopedPublicBaseUrl({
        baseUrl: readMcpPublicOrigin(this.#env),
        publicPrefix: MCP_PUBLIC_PREFIX,
        scope: ownerScope,
      }),
      onServerConfigurationChanged: async (payload, context) => {
        const scope = ownerScope;
        await this.#runtimeServices.objects.automations.for(scope).ingestEvent(
          {
            id: context.hookId.toString(),
            scope,
            source: "mcp",
            eventType: "server.configuration.changed",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actors: {
              initiator: AUTOMATION_SYSTEM_INITIATOR,
              principal: null,
              delegation: [],
            },
            subject: scopeSubject(scope, payload.serverId),
          },
          { propagationContext: context.capturePropagationContext() },
        );
      },
      onServerConfigurationDeleted: async (payload, context) => {
        const scope = ownerScope;
        await this.#runtimeServices.objects.automations.for(scope).ingestEvent(
          {
            id: context.hookId.toString(),
            scope,
            source: "mcp",
            eventType: "server.configuration.deleted",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actors: {
              initiator: AUTOMATION_SYSTEM_INITIATOR,
              principal: null,
              delegation: [],
            },
            subject: scopeSubject(scope, payload.serverId),
          },
          { propagationContext: context.capturePropagationContext() },
        );
      },
    };
  }

  async getDurableHookRepository() {
    const fragment = await this.#scopedRuntime.getRuntime();
    return createDurableHookRepository(() => fragment);
  }

  async alarm(): Promise<void> {
    await this.#scopedRuntime.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(await this.#scopedRuntime.getRuntime(), request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}

export class Mcp extends DurableObject<CloudflareEnv> implements McpObject {
  readonly #object: InMemoryMcpObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryMcpObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  init(scope: BackofficeContextScope): McpObject {
    return this.#object.init(scope);
  }

  async getPublicBaseUrl(): Promise<string> {
    return await this.#object.getPublicBaseUrl();
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  async getDurableHookRepository() {
    return await this.#object.getDurableHookRepository();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
