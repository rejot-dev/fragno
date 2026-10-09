import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import { backofficeRoutableScopeSchema } from "@/backoffice-runtime/context-schema";
import { createBackofficeFragmentHttpTransport } from "@/backoffice-runtime/fragment-http-transport";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  backofficeContextScopeFromDurableObjectId,
  requireBackofficeContextScopeFromDurableObjectId,
  backofficeObjectScopeFromContextScope,
  type ApiObject,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { createApiServer, type ApiConfig, type ApiFragment } from "@/fragno/api";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import { encodeApiConnectionId } from "@/fragno/runtime-tools/families/integrations/api-integration";
import { recordIntegrationConnectionState } from "@/fragno/runtime-tools/families/integrations/integration-events";
import {
  API_PUBLIC_PREFIX,
  isScopedPublicOAuthRedirectUriAllowed,
} from "@/fragno/scoped-public-fragment-routes";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";
import {
  createScopedFragmentDurableObjectRuntime,
  type ScopedFragmentDurableObjectRuntime,
} from "./lib/scoped-fragment-durable-object";

function scopeSubject(scope: BackofficeRoutableScope, subject?: Record<string, unknown>) {
  return {
    scope,
    ...(scope.kind === "org" || scope.kind === "project" ? { orgId: scope.orgId } : {}),
    ...subject,
  };
}

export class InMemoryApiObject extends RpcTarget implements ApiObject {
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #forwardHttpRequest: ReturnType<typeof createBackofficeFragmentHttpTransport>;
  readonly #host: FragmentDurableObjectHost<ApiConfig, ApiFragment>;
  readonly #scopedRuntime: ScopedFragmentDurableObjectRuntime<ApiFragment, BackofficeRoutableScope>;
  readonly #fetch: typeof fetch;

  constructor({
    state,
    env,
    nowEpochMs,
    runtime,
    implementation,
    fetch: fetchImpl = fetch,
  }: {
    state: BackofficeObjectState;
    env: Pick<CloudflareEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;
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
        binding: "API",
        scope: backofficeObjectScopeFromContextScope(
          requireBackofficeContextScopeFromDurableObjectId(state.id, "API"),
        ),
      },
      env,
      nowEpochMs,
    });
    this.#host = implementation.createFragmentHost({
      name: "API",
      createRuntime: (config) =>
        createApiServer(config, implementation.fragmentDatabase, new BackofficeKernel(runtime)),
      onProcessError: (error) => {
        console.error("API hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("API hook dispatcher initialization failed", error);
      },
    });
    this.#scopedRuntime = createScopedFragmentDurableObjectRuntime({
      name: "API",
      state,
      ownerScope: backofficeContextScopeFromDurableObjectId(state.id, "API"),
      host: this.#host,
      scopeSchema: backofficeRoutableScopeSchema,
      createSource: (scope) => this.#createConfig(scope),
    });

    void state.blockConcurrencyWhile(async () => {
      // Restore inside the constructor boundary so alarms cannot run before the dispatcher exists.
      await this.#scopedRuntime.initializeFromOwnerScope();
    });
  }

  #createConfig(ownerScope: BackofficeRoutableScope): ApiConfig {
    return {
      fetch: this.#fetch,
      allowedOAuthRedirectUris: (redirectUri) =>
        isScopedPublicOAuthRedirectUriAllowed({
          publicOrigin: this.#runtimeServices.config.docsPublicBaseUrl,
          publicPrefix: API_PUBLIC_PREFIX,
          redirectUri,
        }),
      onConnectionDeleted: async (payload, context) => {
        await recordIntegrationConnectionState(
          this.#runtimeServices.objects.automations.for(ownerScope).commands,
          {
            id: context.hookId.toString(),
            scope: ownerScope,
            service: "api",
            connectionId: encodeApiConnectionId(payload.connectionId),
            state: "disconnected",
            occurredAt: context.createdAt,
          },
          { propagationContext: context.capturePropagationContext() },
        );
      },
      onConnectionReadinessChanged: async (payload, context) => {
        await recordIntegrationConnectionState(
          this.#runtimeServices.objects.automations.for(ownerScope).commands,
          {
            id: context.hookId.toString(),
            scope: ownerScope,
            service: "api",
            connectionId: encodeApiConnectionId(payload.connectionId),
            state: payload.ready ? "ready" : "unavailable",
            occurredAt: context.createdAt,
          },
          { propagationContext: context.capturePropagationContext() },
        );
      },
      onWebhookEndpointChanged: async (payload, context) => {
        const automations = this.#runtimeServices.objects.automations.for(ownerScope);
        await automations.commands.ensureEventSource({
          source: payload.endpointId,
          label: payload.endpoint.name,
          description: `${payload.endpoint.name} webhook events received through the API.`,
          category: "custom",
        });
        if (payload.change !== "created") {
          return;
        }
        await automations.commands.ingestEvent(
          {
            id: context.hookId.toString(),
            scopeRestriction: null,
            scope: ownerScope,
            source: "api",
            eventType: "webhook_endpoint.created",
            occurredAt: new Date().toISOString(),
            payload: { endpointId: payload.endpointId, ...payload.endpoint },
            actors: {
              initiator: AUTOMATION_SYSTEM_INITIATOR,
              principal: null,
              delegation: [],
            },
            subject: scopeSubject(ownerScope, { endpointId: payload.endpointId }),
          },
          { propagationContext: context.capturePropagationContext() },
        );
      },
      onWebhookReceived: async (payload, context) => {
        const scope = ownerScope;
        await this.#runtimeServices.objects.automations.for(scope).commands.ingestEvent(
          {
            id: payload.hookId,
            scopeRestriction: null,
            scope,
            source: "api",
            eventType: "webhook.received",
            occurredAt: payload.receivedAt,
            payload: { ...payload },
            actors: {
              initiator: AUTOMATION_SYSTEM_INITIATOR,
              principal: null,
              delegation: [],
            },
            subject: scopeSubject(scope, {
              endpointId: payload.endpointId,
              deliveryId: payload.deliveryId,
            }),
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

export class Api extends DurableObject<CloudflareEnv> implements ApiObject {
  readonly #object: InMemoryApiObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryApiObject(createCloudflareBackofficeObjectContext(state, env));
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
