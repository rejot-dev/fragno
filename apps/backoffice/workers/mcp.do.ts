import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import {
  backofficeContextScopeFromDurableObjectId,
  type McpObject,
} from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import { createMcpServer, type McpConfig, type McpFragment } from "@/fragno/mcp";
import {
  isScopedPublicOAuthRedirectUriAllowed,
  MCP_PUBLIC_PREFIX,
} from "@/fragno/scoped-public-fragment-routes";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import { cloudflareDurableHooksInstrumentation } from "./lib/cloudflare-durable-hooks-instrumentation";
import {
  createScopedFragmentDurableObjectRuntime,
  type ScopedFragmentDurableObjectRuntime,
} from "./lib/scoped-fragment-durable-object";

type McpObjectEnv = object;

function scopeSubject(scope: BackofficeRoutableScope, serverId?: string) {
  return {
    scope,
    ...(scope.kind === "org" || scope.kind === "project" ? { orgId: scope.orgId } : {}),
    ...(serverId ? { serverId } : {}),
  };
}

export class InMemoryMcpObject extends RpcTarget implements McpObject {
  readonly #env: McpObjectEnv;
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
        console.warn("MCP hook dispatcher initialization failed", error);
      },
    });
    this.#scopedRuntime = createScopedFragmentDurableObjectRuntime({
      name: "MCP",
      state,
      ownerScope: backofficeContextScopeFromDurableObjectId(state.id, "MCP"),
      host: this.#host,
      createSource: (scope) => this.#createConfig(scope),
    });

    void state.blockConcurrencyWhile(async () => {
      // Restore inside the constructor boundary so alarms cannot run before the dispatcher exists.
      await this.#scopedRuntime.initializeFromOwnerScope();
    });
  }

  #createConfig(ownerScope: BackofficeRoutableScope): McpConfig {
    return {
      allowedOAuthRedirectUris: (redirectUri) =>
        isScopedPublicOAuthRedirectUriAllowed({
          publicOrigin: this.#runtimeServices.config.docsPublicBaseUrl,
          publicPrefix: MCP_PUBLIC_PREFIX,
          redirectUri,
        }),
      onServerConfigurationChanged: async (payload, context) => {
        const scope = ownerScope;
        await this.#runtimeServices.objects.automations.for(scope).commands.ingestEvent(
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
        await this.#runtimeServices.objects.automations.for(scope).commands.ingestEvent(
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

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await loadDurableHookQueue(await this.#scopedRuntime.getRuntime(), options);
  }

  async getDurableHook(hookId: string) {
    return await loadDurableHook(await this.#scopedRuntime.getRuntime(), hookId);
  }

  async alarm(): Promise<void> {
    await this.#scopedRuntime.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(await this.#scopedRuntime.getRuntime(), request);
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

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await this.#object.getDurableHookQueue(options);
  }

  async getDurableHook(hookId: string) {
    return await this.#object.getDurableHook(hookId);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
