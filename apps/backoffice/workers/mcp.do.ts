import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { McpObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import {
  backofficeScopeSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
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
  scope: BackofficeRoutableScope;
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

const mcpOwnerScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org"), orgId: z.string().trim().min(1) }),
  z.object({
    kind: z.literal("project"),
    orgId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
  }),
  z.object({ kind: z.literal("user"), userId: z.string().trim().min(1) }),
]);

const setAdminConfigInputSchema = mcpConfigureInputSchema.extend({
  scope: mcpOwnerScopeSchema,
});

const readMcpPublicOrigin = (env: McpObjectEnv) => {
  const origin = env.DOCS_PUBLIC_BASE_URL?.trim();
  if (!origin) {
    throw new Error("MCP OAuth redirect origin is not configured.");
  }
  return origin;
};

const resolvePublicBaseUrl = (env: McpObjectEnv, scope: BackofficeRoutableScope) =>
  resolveMcpPublicBaseUrl({ baseUrl: readMcpPublicOrigin(env), scope });

const assertSameScope = (existing: StoredMcpConfig | null, nextScope: BackofficeRoutableScope) => {
  if (!existing) {
    return;
  }

  if (
    backofficeScopeSinglePathSegment(existing.scope) !== backofficeScopeSinglePathSegment(nextScope)
  ) {
    throw new Error("MCP is already configured for a different scope.");
  }
};

const scopeSubject = (scope: BackofficeRoutableScope, serverId?: string) => ({
  scope,
  ...(scope.kind === "org" || scope.kind === "project" ? { orgId: scope.orgId } : {}),
  ...(serverId ? { serverId } : {}),
});

const buildServerConfigurationChangedEventId = (input: {
  scopeKey: string;
  serverId: string;
  idempotencyKey: string;
}) =>
  `mcp:server.configuration.changed:${input.scopeKey}:${input.serverId}:${input.idempotencyKey}`;

const buildServerConfigurationDeletedEventId = (input: {
  scopeKey: string;
  serverId: string;
  idempotencyKey: string;
}) =>
  `mcp:server.configuration.deleted:${input.scopeKey}:${input.serverId}:${input.idempotencyKey}`;

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
      publicBaseUrl: resolvePublicBaseUrl(env, config.scope),
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
      getStoredOrgId: (stored) => {
        const scope = stored.scope;
        if (scope.kind === "org" || scope.kind === "project") {
          return scope.orgId;
        }
        return `user:${scope.userId}`;
      },
      toSource: (stored) => ({
        publicBaseUrl: resolvePublicBaseUrl(this.#env, stored.scope),
        onServerConfigurationChanged: async (payload, idempotencyKey) => {
          const scope = stored.scope;
          await this.#runtimeServices.objects.automations.for(scope).ingestEvent({
            id: buildServerConfigurationChangedEventId({
              scopeKey: backofficeScopeSinglePathSegment(scope),
              serverId: payload.serverId,
              idempotencyKey,
            }),
            scope,
            source: "mcp",
            eventType: "server.configuration.changed",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: scopeSubject(scope, payload.serverId),
          });
        },
        onServerConfigurationDeleted: async (payload, idempotencyKey) => {
          const scope = stored.scope;
          await this.#runtimeServices.objects.automations.for(scope).ingestEvent({
            id: buildServerConfigurationDeletedEventId({
              scopeKey: backofficeScopeSinglePathSegment(scope),
              serverId: payload.serverId,
              idempotencyKey,
            }),
            scope,
            source: "mcp",
            eventType: "server.configuration.deleted",
            occurredAt: new Date().toISOString(),
            payload: { ...payload },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: scopeSubject(scope, payload.serverId),
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

          const scope = stored.scope;
          await this.#runtimeServices.objects.automations.for(scope).ingestEvent({
            id: item.id,
            scope,
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
              ...scopeSubject(scope),
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
    const scope = parsed.scope;
    const existing = await this.#host.loadStored();
    assertSameScope(existing, scope);

    const now = new Date().toISOString();
    const stored: StoredMcpConfig = {
      scope,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.storeAndInitialize(stored);
      const configuredAt = new Date().toISOString();
      await this.#host.dispatch({
        id: `mcp:capability.configured:${backofficeScopeSinglePathSegment(scope)}:${configuredAt}`,
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
