import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import { backofficeRoutableScopeSchema } from "@/backoffice-runtime/context-schema";
import { createBackofficeFragmentHttpTransport } from "@/backoffice-runtime/fragment-http-transport";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  backofficeContextScopeFromDurableObjectId,
  requireBackofficeContextScopeFromDurableObjectId,
  backofficeObjectScopeFromContextScope,
  type McpObject,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
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
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";
import {
  createScopedFragmentDurableObjectRuntime,
  type ScopedFragmentDurableObjectRuntime,
} from "./lib/scoped-fragment-durable-object";

type McpObjectEnv = Pick<CloudflareEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;

function scopeSubject(scope: BackofficeRoutableScope, serverId?: string) {
  return {
    scope,
    ...(scope.kind === "org" || scope.kind === "project" ? { orgId: scope.orgId } : {}),
    ...(serverId ? { serverId } : {}),
  };
}

export class InMemoryMcpObject extends RpcTarget implements McpObject {
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #forwardHttpRequest: ReturnType<typeof createBackofficeFragmentHttpTransport>;
  readonly #host: FragmentDurableObjectHost<McpConfig, McpFragment>;
  readonly #scopedRuntime: ScopedFragmentDurableObjectRuntime<McpFragment, BackofficeRoutableScope>;
  readonly #fetch: typeof fetch;

  constructor({
    state,
    env = {},
    nowEpochMs,
    runtime,
    implementation,
    fetch: fetchImpl = fetch,
  }: {
    state: BackofficeObjectState;
    env?: McpObjectEnv;
    nowEpochMs: () => number;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    fetch?: typeof fetch;
  }) {
    super();
    this.#runtimeServices = runtime;
    this.#fetch = fetchImpl;
    this.#forwardHttpRequest = createBackofficeFragmentHttpTransport({
      address: {
        binding: "MCP",
        scope: backofficeObjectScopeFromContextScope(
          requireBackofficeContextScopeFromDurableObjectId(state.id, "MCP"),
        ),
      },
      env,
      nowEpochMs,
    });
    this.#host = implementation.createFragmentHost({
      name: "MCP",
      createRuntime: (config) =>
        createMcpServer(config, implementation.fragmentDatabase, new BackofficeKernel(runtime)),
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
      scopeSchema: backofficeRoutableScopeSchema,
      createSource: (scope) => this.#createConfig(scope),
    });

    void state.blockConcurrencyWhile(async () => {
      // Restore inside the constructor boundary so alarms cannot run before the dispatcher exists.
      await this.#scopedRuntime.initializeFromOwnerScope();
    });
  }

  #createConfig(ownerScope: BackofficeRoutableScope): McpConfig {
    return {
      fetch: this.#fetch,
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
            scopeRestriction: null,
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
            scopeRestriction: null,
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
    return await this.#forwardHttpRequest(request, async (verifiedRequest, options) =>
      this.#host.fetch(await this.#scopedRuntime.getRuntime(), verifiedRequest, options),
    );
  }
}

export class Mcp extends DurableObject<CloudflareEnv> implements McpObject {
  readonly #object: InMemoryMcpObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryMcpObject(createCloudflareBackofficeObjectContext(state, env));
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
