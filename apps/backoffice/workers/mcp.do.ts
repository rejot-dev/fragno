import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { mcpConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/mcp";
import {
  createMcpServer,
  resolveMcpPublicBaseUrl,
  type McpConfig,
  type McpFragment,
} from "@/fragno/mcp";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
} from "./lib/backoffice-fragment-durable-object";

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

const readMcpPublicOrigin = (env: CloudflareEnv) => {
  const origin = env.DOCS_PUBLIC_BASE_URL?.trim();
  if (!origin) {
    throw new Error("MCP OAuth redirect origin is not configured.");
  }
  return origin;
};

const resolvePublicBaseUrl = (env: CloudflareEnv, orgId: string) =>
  resolveMcpPublicBaseUrl({ baseUrl: readMcpPublicOrigin(env), orgId });

function buildConfigResponse(
  env: CloudflareEnv,
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

export class Mcp extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #host: BackofficeFragmentDurableObject<StoredMcpConfig, McpConfig, McpFragment>;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
    this.#host = createBackofficeFragmentDurableObject({
      name: "MCP",
      state,
      env,
      toSource: (stored) => ({
        publicBaseUrl: resolvePublicBaseUrl(env, stored.orgId),
      }),
      createRuntime: (config) => createMcpServer(config, state),
    });

    void state.blockConcurrencyWhile(async () => {
      await this.#host.initializeFromStored(await this.#host.loadStored());
    });
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
    });

    return buildConfigResponse(this.#env, stored);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(request);
  }
}
