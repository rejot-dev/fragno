import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { ApiObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import {
  createApiServer,
  resolveApiPublicBaseUrl,
  type ApiConfig,
  type ApiFragment,
} from "@/fragno/api";
import { AUTOMATION_SYSTEM_ACTOR } from "@/fragno/automation/contracts";
import { apiConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/api";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
  type BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";

type ApiObjectEnv = {
  DOCS_PUBLIC_BASE_URL?: string;
};

type StoredApiConfig = {
  orgId: string;
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

const setAdminConfigInputSchema = apiConfigureInputSchema.extend({
  orgId: z.string().trim().min(1, "Missing organisation id."),
});

const readApiPublicOrigin = (env: ApiObjectEnv) => {
  const origin = env.DOCS_PUBLIC_BASE_URL?.trim();
  if (!origin) {
    throw new Error("API public origin is not configured.");
  }
  return origin;
};

const resolvePublicBaseUrl = (env: ApiObjectEnv, orgId: string) =>
  resolveApiPublicBaseUrl({ baseUrl: readApiPublicOrigin(env), orgId });

const buildConnectionChangedEventId = (input: {
  orgId: string;
  connectionId: string;
  idempotencyKey: string;
}) => `api:connection.changed:${input.orgId}:${input.connectionId}:${input.idempotencyKey}`;

const buildConnectionDeletedEventId = (input: {
  orgId: string;
  connectionId: string;
  idempotencyKey: string;
}) => `api:connection.deleted:${input.orgId}:${input.connectionId}:${input.idempotencyKey}`;

const buildConnectionAvailableEventId = (input: {
  orgId: string;
  connectionId: string;
  idempotencyKey: string;
}) => `api:connection.available:${input.orgId}:${input.connectionId}:${input.idempotencyKey}`;

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
      publicBaseUrl: resolvePublicBaseUrl(env, config.orgId),
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    },
  };
}

export class InMemoryApiObject implements ApiObject {
  #env: ApiObjectEnv;
  #state: BackofficeObjectState;
  #runtimeServices: BackofficeRuntimeServices;
  #host: BackofficeFragmentDurableObject<StoredApiConfig, ApiConfig, ApiFragment>;

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
      toSource: (stored) => ({
        publicBaseUrl: resolvePublicBaseUrl(this.#env, stored.orgId),
        onConnectionChanged: async (payload, idempotencyKey) => {
          await this.#runtimeServices.objects.automations.forOrg(stored.orgId).ingestEvent({
            id: buildConnectionChangedEventId({
              orgId: stored.orgId,
              connectionId: payload.connectionId,
              idempotencyKey,
            }),
            scope: { kind: "org", orgId: stored.orgId },
            source: "api",
            eventType: "connection.changed",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: stored.orgId,
              connectionId: payload.connectionId,
            },
          });
        },
        onConnectionDeleted: async (payload, idempotencyKey) => {
          await this.#runtimeServices.objects.automations.forOrg(stored.orgId).ingestEvent({
            id: buildConnectionDeletedEventId({
              orgId: stored.orgId,
              connectionId: payload.connectionId,
              idempotencyKey,
            }),
            scope: { kind: "org", orgId: stored.orgId },
            source: "api",
            eventType: "connection.deleted",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: stored.orgId,
              connectionId: payload.connectionId,
            },
          });
        },
        onConnectionAvailable: async (payload, idempotencyKey) => {
          await this.#runtimeServices.objects.automations.forOrg(stored.orgId).ingestEvent({
            id: buildConnectionAvailableEventId({
              orgId: stored.orgId,
              connectionId: payload.connectionId,
              idempotencyKey,
            }),
            scope: { kind: "org", orgId: stored.orgId },
            source: "api",
            eventType: "connection.available",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: stored.orgId,
              connectionId: payload.connectionId,
            },
          });
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

          await this.#runtimeServices.objects.automations.forOrg(stored.orgId).ingestEvent({
            id: item.id,
            scope: { kind: "org", orgId: stored.orgId },
            source: "api",
            eventType: "capability.configured",
            occurredAt: item.createdAt,
            payload: {
              capabilityId: "api",
              capabilityLabel: "API",
            },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: stored.orgId,
              capabilityId: "api",
            },
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
    const existing = await this.#host.loadStored();
    this.#host.assertSameOrg(existing, parsed.orgId);

    const now = new Date().toISOString();
    const stored: StoredApiConfig = {
      orgId: parsed.orgId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.storeAndInitialize(stored);
      const configuredAt = new Date().toISOString();
      await this.#host.dispatch({
        id: `api:capability.configured:${parsed.orgId}:${configuredAt}`,
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
  #object: InMemoryApiObject;

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
