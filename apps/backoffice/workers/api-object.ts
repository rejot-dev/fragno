import type { WebhookEndpointChangedPayload } from "@fragno-dev/api-fragment/definition";
import {
  type BackofficeRoutableScope,
  backofficeRoutableScopeSchema,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { RpcTarget } from "cloudflare:workers";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import { createBackofficeFragmentHttpTransport } from "@/backoffice-runtime/fragment-http-transport";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  backofficeContextScopeFromDurableObjectId,
  requireBackofficeContextScopeFromDurableObjectId,
  backofficeObjectScopeFromContextScope,
  type ApiCommands,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createApiServer, type ApiConfig, type ApiFragment } from "@/fragno/api";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import { encodeApiConnectionId } from "@/fragno/runtime-tools/families/integrations/api-integration";
import { recordIntegrationConnectionState } from "@/fragno/runtime-tools/families/integrations/integration-events";
import { authMethodOfFragmentAuthMode } from "@/fragno/runtime-tools/families/integrations/integration-implementation";
import {
  authMethodOfWebhookAuth,
  encodeWebhookConnectionId,
} from "@/fragno/runtime-tools/families/integrations/webhook-integration";
import {
  API_PUBLIC_PREFIX,
  isScopedPublicOAuthRedirectUriAllowed,
} from "@/fragno/scoped-public-fragment-routes";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import {
  createScopedFragmentDurableObjectRuntime,
  type ScopedFragmentDurableObjectRuntime,
} from "./lib/scoped-fragment-durable-object";

/** Processed deliveries stay readable for agents and debugging; their automation events outlive them. */
const API_WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function scopeSubject(scope: BackofficeRoutableScope, subject?: Record<string, unknown>) {
  return { scope, ...subject };
}

/** An endpoint is ready while it accepts deliveries; writes that keep that unchanged report nothing. */
function webhookEndpointStateChange(payload: WebhookEndpointChangedPayload) {
  switch (payload.change) {
    case "created":
    case "updated": {
      const ready = payload.endpoint.status === "active";
      if (payload.change === "updated" && ready === (payload.previousStatus === "active")) {
        return null;
      }
      return {
        state: ready ? ("ready" as const) : ("unavailable" as const),
        label: {
          name: payload.endpoint.name,
          authMethod: authMethodOfWebhookAuth(payload.endpoint.authConfig),
        },
      };
    }
    case "deleted":
      return { state: "disconnected" as const };
    default:
      throw new Error("Webhook endpoint change is unsupported.", {
        cause: payload satisfies never,
      });
  }
}

export class ApiObject extends RpcTarget implements ApiCommands {
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
    env: Pick<BackofficeRuntimeEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;
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
      webhookDeliveryRetentionMs: API_WEBHOOK_DELIVERY_RETENTION_MS,
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
            label: {
              name: payload.connection?.name ?? payload.connectionId,
              authMethod:
                payload.connection && authMethodOfFragmentAuthMode(payload.connection.authMode),
            },
            occurredAt: context.createdAt,
          },
          { propagationContext: context.capturePropagationContext() },
        );
      },
      onWebhookEndpointChanged: async (payload, context) => {
        const automations = this.#runtimeServices.objects.automations.for(ownerScope);
        // A deleted endpoint's source stays, with the catalog entries and routes that name it.
        if (payload.change !== "deleted") {
          await automations.commands.ensureEventSource({
            source: payload.endpointId,
            label: payload.endpoint.name,
            description: `${payload.endpoint.name} webhook events received through the API.`,
            category: "custom",
          });
        }
        const stateChange = webhookEndpointStateChange(payload);
        if (stateChange === null) {
          return;
        }
        await recordIntegrationConnectionState(
          automations.commands,
          {
            id: context.hookId.toString(),
            scope: ownerScope,
            service: "webhook",
            connectionId: encodeWebhookConnectionId(payload.endpointId),
            ...stateChange,
            occurredAt: context.createdAt,
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
            causation: { kind: "origin" },
          },
          { propagationContext: context.capturePropagationContext() },
        );
      },
    };
  }

  async warm(): Promise<void> {}

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await loadDurableHookQueue(await this.#scopedRuntime.getRuntime(), options);
  }

  async getDurableHook(hookId: string) {
    return await loadDurableHook(await this.#scopedRuntime.getRuntime(), hookId);
  }

  async wakeDurableHooks() {
    await this.#host.wake();
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
