import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import {
  backofficeContextScopeFromDurableObjectId,
  type ApiObject,
} from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { createApiServer, type ApiConfig, type ApiFragment } from "@/fragno/api";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import {
  API_PUBLIC_PREFIX,
  isScopedPublicOAuthRedirectUriAllowed,
} from "@/fragno/scoped-public-fragment-routes";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import { cloudflareDurableHooksInstrumentation } from "./lib/cloudflare-durable-hooks-instrumentation";
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
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #host: FragmentDurableObjectHost<ApiConfig, ApiFragment>;
  readonly #scopedRuntime: ScopedFragmentDurableObjectRuntime<ApiFragment>;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env: object;
    runtime: BackofficeRuntimeServices;
  }) {
    super();
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#host = createFragmentDurableObjectHost({
      name: "API",
      state,
      env,
      createRuntime: (config) =>
        createApiServer(config, {
          adapters: this.#runtimeServices.adapters,
        }),
      durableHooksInstrumentation: cloudflareDurableHooksInstrumentation,
      onProcessError: (error) => {
        console.error("API hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("API hook processor disabled", error);
      },
    });
    this.#scopedRuntime = createScopedFragmentDurableObjectRuntime({
      name: "API",
      state,
      ownerScope: backofficeContextScopeFromDurableObjectId(state.id, "API"),
      host: this.#host,
      createSource: (scope) => this.#createConfig(scope),
    });

    void state.blockConcurrencyWhile(async () => {
      // Restore inside the constructor boundary so alarms cannot run before the dispatcher exists.
      await this.#scopedRuntime.initializeFromOwnerScope();
    });
  }

  #createConfig(ownerScope: BackofficeRoutableScope): ApiConfig {
    return {
      allowedOAuthRedirectUris: (redirectUri) =>
        isScopedPublicOAuthRedirectUriAllowed({
          publicOrigin: this.#runtimeServices.config.docsPublicBaseUrl,
          publicPrefix: API_PUBLIC_PREFIX,
          redirectUri,
        }),
      onConnectionChanged: async (payload, context) => {
        const scope = ownerScope;
        await this.#runtimeServices.objects.automations.for(scope).commands.ingestEvent(
          {
            id: context.hookId.toString(),
            scope,
            source: "api",
            eventType: "connection.changed",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actors: {
              initiator: AUTOMATION_SYSTEM_INITIATOR,
              principal: null,
              delegation: [],
            },
            subject: scopeSubject(scope, {
              connectionId: payload.connectionId,
            }),
          },
          { propagationContext: context.capturePropagationContext() },
        );
      },
      onConnectionDeleted: async (payload, context) => {
        const scope = ownerScope;
        await this.#runtimeServices.objects.automations.for(scope).commands.ingestEvent(
          {
            id: context.hookId.toString(),
            scope,
            source: "api",
            eventType: "connection.deleted",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actors: {
              initiator: AUTOMATION_SYSTEM_INITIATOR,
              principal: null,
              delegation: [],
            },
            subject: scopeSubject(scope, {
              connectionId: payload.connectionId,
            }),
          },
          { propagationContext: context.capturePropagationContext() },
        );
      },
      onConnectionAvailable: async (payload, context) => {
        const scope = ownerScope;
        await this.#runtimeServices.objects.automations.for(scope).commands.ingestEvent(
          {
            id: context.hookId.toString(),
            scope,
            source: "api",
            eventType: "connection.available",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actors: {
              initiator: AUTOMATION_SYSTEM_INITIATOR,
              principal: null,
              delegation: [],
            },
            subject: scopeSubject(scope, {
              connectionId: payload.connectionId,
            }),
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
    return await this.#host.fetch(await this.#scopedRuntime.getRuntime(), request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}

export class Api extends DurableObject<CloudflareEnv> implements ApiObject {
  readonly #object: InMemoryApiObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryApiObject({
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
