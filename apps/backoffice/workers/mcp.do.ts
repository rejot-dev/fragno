import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { McpObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { AUTOMATION_SYSTEM_ACTOR } from "@/fragno/automation/contracts";
import { mcpConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/mcp";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";
import {
  createMcpServer,
  resolveMcpPublicBaseUrl,
  type McpConfig,
  type McpFragment,
} from "@/fragno/mcp";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
  type BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";

type McpObjectEnv = {
  DOCS_PUBLIC_BASE_URL?: string;
};

type StoredMcpConfig = {
  orgId: string;
  createdAt: string;
  updatedAt: string;
};

export type McpAdminConfigResponse = {
  configured: boolean;
  config?: {
    publicBaseUrl?: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
};

const setAdminConfigInputSchema = mcpConfigureInputSchema.extend({
  orgId: z.string().trim().min(1, "Missing organisation id."),
});

const readMcpPublicOrigin = (env: McpObjectEnv) => {
  const origin = env.DOCS_PUBLIC_BASE_URL?.trim();
  if (!origin) {
    throw new Error("MCP OAuth redirect origin is not configured.");
  }
  return origin;
};

const resolvePublicBaseUrl = (env: McpObjectEnv, orgId: string) =>
  resolveMcpPublicBaseUrl({ baseUrl: readMcpPublicOrigin(env), orgId });

const buildServerConfigurationChangedEventId = (input: {
  orgId: string;
  serverId: string;
  idempotencyKey: string;
}) => `mcp:server.configuration.changed:${input.orgId}:${input.serverId}:${input.idempotencyKey}`;

const buildServerConfigurationDeletedEventId = (input: {
  orgId: string;
  serverId: string;
  idempotencyKey: string;
}) => `mcp:server.configuration.deleted:${input.orgId}:${input.serverId}:${input.idempotencyKey}`;

function buildConfigResponse(
  env: McpObjectEnv,
  config: StoredMcpConfig | null,
): McpAdminConfigResponse {
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

export class InMemoryMcpObject implements McpObject {
  #env: McpObjectEnv;
  #state: BackofficeObjectState;
  #runtimeServices: BackofficeRuntimeServices;
  #host: BackofficeFragmentDurableObject<StoredMcpConfig, McpConfig, McpFragment>;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env?: McpObjectEnv;
    runtime: BackofficeRuntimeServices;
  }) {
    this.#env = env ?? {};
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#host = createBackofficeFragmentDurableObject({
      name: "MCP",
      state,
      env: this.#env,
      toSource: (stored) => ({
        publicBaseUrl: resolvePublicBaseUrl(this.#env, stored.orgId),
        onServerConfigurationChanged: async (payload, idempotencyKey) => {
          await this.#runtimeServices.objects.automations.forOrg(stored.orgId).ingestEvent({
            id: buildServerConfigurationChangedEventId({
              orgId: stored.orgId,
              serverId: payload.serverId,
              idempotencyKey,
            }),
            orgId: stored.orgId,
            source: "mcp",
            eventType: "server.configuration.changed",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: stored.orgId,
              serverId: payload.serverId,
            },
          });
        },
        onServerConfigurationDeleted: async (payload, idempotencyKey) => {
          await this.#runtimeServices.objects.automations.forOrg(stored.orgId).ingestEvent({
            id: buildServerConfigurationDeletedEventId({
              orgId: stored.orgId,
              serverId: payload.serverId,
              idempotencyKey,
            }),
            orgId: stored.orgId,
            source: "mcp",
            eventType: "server.configuration.deleted",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: stored.orgId,
              serverId: payload.serverId,
            },
          });
        },
      }),
      createRuntime: (config) =>
        createMcpServer(config, {
          adapters: this.#runtimeServices.adapters,
        }),
      outbox: {
        dispatch: async (item, { stored }) => {
          if (item.type !== "capability.configured") {
            return;
          }

          await this.#runtimeServices.objects.automations.forOrg(stored.orgId).ingestEvent({
            id: item.id,
            orgId: stored.orgId,
            source: "mcp",
            eventType: "capability.configured",
            occurredAt: item.createdAt,
            payload: {
              capabilityId: "mcp",
              capabilityLabel: "MCP",
            },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: stored.orgId,
              capabilityId: "mcp",
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

  async getAdminConfig(): Promise<McpAdminConfigResponse> {
    const config = await this.#host.loadStored();
    return buildConfigResponse(this.#env, config);
  }

  async resetAdminConfig(): Promise<McpAdminConfigResponse> {
    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.clearConfig();
    });
    return { configured: false };
  }

  async setAdminConfig(payload: unknown): Promise<McpAdminConfigResponse> {
    const parsed = setAdminConfigInputSchema.parse(payload);
    const existing = await this.#host.loadStored();
    this.#host.assertSameOrg(existing, parsed.orgId);

    const now = new Date().toISOString();
    const stored: StoredMcpConfig = {
      orgId: parsed.orgId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.storeAndInitialize(stored);
      const configuredAt = new Date().toISOString();
      await this.#host.dispatch({
        id: `mcp:capability.configured:${parsed.orgId}:${configuredAt}`,
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

export class Mcp extends DurableObject<CloudflareEnv> implements McpObject {
  #object: InMemoryMcpObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryMcpObject({
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

  async getAdminConfig(): Promise<McpAdminConfigResponse> {
    return await this.#object.getAdminConfig();
  }

  async resetAdminConfig(): Promise<McpAdminConfigResponse> {
    return await this.#object.resetAdminConfig();
  }

  async setAdminConfig(payload: unknown): Promise<McpAdminConfigResponse> {
    return await this.#object.setAdminConfig(payload);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
