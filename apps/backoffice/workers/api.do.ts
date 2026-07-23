import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { ApiObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import {
  assertSameBackofficeRoutableScope,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import { createApiServer, type ApiConfig, type ApiFragment } from "@/fragno/api";
import { AUTOMATION_SYSTEM_ACTOR } from "@/fragno/automation/contracts";
import { apiConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/api";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";
import { API_PUBLIC_PREFIX, scopedPublicBaseUrl } from "@/fragno/scoped-public-fragment-routes";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
  type BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";

type ApiObjectEnv = {
  DOCS_PUBLIC_BASE_URL?: string;
};

type StoredApiConfig = {
  scope: BackofficeRoutableScope;
  createdAt: string;
  updatedAt: string;
};

export type ApiAdminConfigResponse = {
  configured: boolean;
  config?: {
    publicBaseUrl?: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
};

const apiOwnerScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org"), orgId: z.string().trim().min(1) }),
  z.object({
    kind: z.literal("project"),
    orgId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
  }),
  z.object({ kind: z.literal("user"), userId: z.string().trim().min(1) }),
]);

const setAdminConfigInputSchema = apiConfigureInputSchema.extend({
  scope: apiOwnerScopeSchema,
});

const readApiPublicOrigin = (env: ApiObjectEnv) => {
  const origin = env.DOCS_PUBLIC_BASE_URL?.trim();
  if (!origin) {
    throw new Error("API public origin is not configured.");
  }
  return origin;
};

const scopeSubject = (scope: BackofficeRoutableScope, subject?: Record<string, unknown>) => ({
  scope,
  ...(scope.kind === "org" || scope.kind === "project" ? { orgId: scope.orgId } : {}),
  ...subject,
});

function buildConfigResponse(
  env: ApiObjectEnv,
  config: StoredApiConfig | null,
): ApiAdminConfigResponse {
  if (!config) {
    return { configured: false };
  }

  return {
    configured: true,
    config: {
      publicBaseUrl: scopedPublicBaseUrl({
        baseUrl: readApiPublicOrigin(env),
        publicPrefix: API_PUBLIC_PREFIX,
        scope: config.scope,
      }),
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    },
  };
}

export class InMemoryApiObject implements ApiObject {
  readonly #env: ApiObjectEnv;
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #host: BackofficeFragmentDurableObject<StoredApiConfig, ApiConfig, ApiFragment>;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env?: ApiObjectEnv;
    runtime: BackofficeRuntimeServices;
  }) {
    this.#env = env ?? {};
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#host = createBackofficeFragmentDurableObject({
      name: "API",
      state,
      env: this.#env,
      getStoredScope: (stored) => stored.scope,
      toSource: (stored) => ({
        publicBaseUrl: scopedPublicBaseUrl({
          baseUrl: readApiPublicOrigin(this.#env),
          publicPrefix: API_PUBLIC_PREFIX,
          scope: stored.scope,
        }),
        onConnectionChanged: async (payload, context) => {
          const scope = stored.scope;
          await this.#runtimeServices.objects.automations.for(scope).ingestEvent(
            {
              id: context.hookId.toString(),
              scope,
              source: "api",
              eventType: "connection.changed",
              occurredAt: new Date().toISOString(),
              payload: { ...payload },
              actor: AUTOMATION_SYSTEM_ACTOR,
              actors: [AUTOMATION_SYSTEM_ACTOR],
              subject: scopeSubject(scope, { connectionId: payload.connectionId }),
            },
            { propagationContext: context.capturePropagationContext() },
          );
        },
        onConnectionDeleted: async (payload, context) => {
          const scope = stored.scope;
          await this.#runtimeServices.objects.automations.for(scope).ingestEvent(
            {
              id: context.hookId.toString(),
              scope,
              source: "api",
              eventType: "connection.deleted",
              occurredAt: new Date().toISOString(),
              payload: { ...payload },
              actor: AUTOMATION_SYSTEM_ACTOR,
              actors: [AUTOMATION_SYSTEM_ACTOR],
              subject: scopeSubject(scope, { connectionId: payload.connectionId }),
            },
            { propagationContext: context.capturePropagationContext() },
          );
        },
        onConnectionAvailable: async (payload, context) => {
          const scope = stored.scope;
          await this.#runtimeServices.objects.automations.for(scope).ingestEvent(
            {
              id: context.hookId.toString(),
              scope,
              source: "api",
              eventType: "connection.available",
              occurredAt: new Date().toISOString(),
              payload: { ...payload },
              actor: AUTOMATION_SYSTEM_ACTOR,
              actors: [AUTOMATION_SYSTEM_ACTOR],
              subject: scopeSubject(scope, { connectionId: payload.connectionId }),
            },
            { propagationContext: context.capturePropagationContext() },
          );
        },
        onWebhookReceived: async (payload, context) => {
          const scope = stored.scope;
          await this.#runtimeServices.objects.automations.for(scope).ingestEvent(
            {
              id: payload.hookId,
              scope,
              source: "api",
              eventType: "webhook.received",
              occurredAt: payload.receivedAt,
              payload: { ...payload },
              actor: AUTOMATION_SYSTEM_ACTOR,
              actors: [AUTOMATION_SYSTEM_ACTOR],
              subject: scopeSubject(scope, {
                endpointId: payload.endpointId,
                deliveryId: payload.deliveryId,
              }),
            },
            { propagationContext: context.capturePropagationContext() },
          );
        },
      }),
      createRuntime: (config) =>
        createApiServer(config, {
          adapters: this.#runtimeServices.adapters,
        }),
      outbox: {
        dispatch: async (item, { stored }) => {
          if (item.type !== "capability.configured") {
            return;
          }

          const scope = stored.scope;
          await this.#runtimeServices.objects.automations.for(scope).ingestEvent({
            id: item.id,
            scope,
            source: "api",
            eventType: "capability.configured",
            occurredAt: item.createdAt,
            payload: {
              capabilityId: "api",
              capabilityLabel: "API",
            },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: scopeSubject(scope, { capabilityId: "api" }),
          });
        },
      },
    });

    void state.blockConcurrencyWhile(async () => {
      await this.#host.initializeFromStored(await this.#host.loadStored());
    });
  }

  async alarm() {
    await this.#host.alarm();
  }

  getDurableHookRepository() {
    return this.#host.getDurableHookRepository<DurableHookQueueOptions>(({ runtime }) => runtime);
  }

  async getAdminConfig(): Promise<ApiAdminConfigResponse> {
    const config = await this.#host.loadStored();
    return buildConfigResponse(this.#env, config);
  }

  async resetAdminConfig(): Promise<ApiAdminConfigResponse> {
    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.clearConfig();
    });
    return { configured: false };
  }

  async setAdminConfig(payload: unknown): Promise<ApiAdminConfigResponse> {
    const parsed = setAdminConfigInputSchema.parse(payload);
    const scope = parsed.scope;
    const existing = await this.#host.loadStored();
    assertSameBackofficeRoutableScope(
      existing?.scope ?? null,
      scope,
      "API is already configured for a different scope.",
    );

    const now = new Date().toISOString();
    const stored: StoredApiConfig = {
      scope,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.storeAndInitialize(stored);
      const configuredAt = new Date().toISOString();
      await this.#host.dispatch({
        id: crypto.randomUUID(),
        type: "capability.configured",
        createdAt: configuredAt,
      });
    });

    return buildConfigResponse(this.#env, stored);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(request);
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

  async alarm() {
    await this.#object.alarm();
  }

  getDurableHookRepository() {
    return this.#object.getDurableHookRepository();
  }

  async getAdminConfig(): Promise<ApiAdminConfigResponse> {
    return await this.#object.getAdminConfig();
  }

  async resetAdminConfig(): Promise<ApiAdminConfigResponse> {
    return await this.#object.resetAdminConfig();
  }

  async setAdminConfig(payload: unknown): Promise<ApiAdminConfigResponse> {
    return await this.#object.setAdminConfig(payload);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
