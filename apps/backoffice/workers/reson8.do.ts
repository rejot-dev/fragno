import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { reson8ConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/reson8";
import { createReson8Server, type Reson8Fragment } from "@/fragno/reson8";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
} from "./lib/backoffice-fragment-durable-object";

type StoredReson8Config = {
  orgId: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
};

type ConfigResponse = {
  configured: boolean;
  config?: {
    apiKeyPreview?: string;
    createdAt?: string;
    updatedAt?: string;
  };
};

export type Reson8RealtimeOriginDiagnostic = {
  origin: string;
  tokenStatus: number | null;
  websocketStatus: number | null;
  websocketAccepted: boolean;
  message: string;
};

const CONFIG_KEY = "reson8-config";
const RESON8_API_BASE_URL = "https://api.reson8.dev/v1";

const maskSecret = (value: string) => {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "••••";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
};

const storedReson8ConfigSchema: z.ZodType<StoredReson8Config> = z.object({
  orgId: z.string().trim().min(1, "Stored Reson8 config is missing an organisation id."),
  apiKey: z.string().trim().min(1, "Stored Reson8 config is missing an API key."),
  createdAt: z.string().trim().min(1, "Stored Reson8 config is missing createdAt."),
  updatedAt: z.string().trim().min(1, "Stored Reson8 config is missing updatedAt."),
});

const setAdminConfigInputSchema = reson8ConfigureInputSchema;

type Reson8Source = Pick<StoredReson8Config, "apiKey">;

const buildConfigResponse = (config: StoredReson8Config | null): ConfigResponse => {
  if (!config) {
    return { configured: false };
  }

  return {
    configured: Boolean(config.apiKey),
    config: {
      apiKeyPreview: maskSecret(config.apiKey),
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    },
  };
};

const buildRealtimeDiagnosticUrl = () => {
  const url = new URL("speech-to-text/realtime", `${RESON8_API_BASE_URL}/`);
  url.searchParams.set("encoding", "pcm_s16le");
  url.searchParams.set("sample_rate", "16000");
  url.searchParams.set("channels", "1");
  return url.toString();
};

export class Reson8 extends DurableObject<CloudflareEnv> {
  #state: DurableObjectState;
  #host: BackofficeFragmentDurableObject<StoredReson8Config, Reson8Source, Reson8Fragment>;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#state = state;
    this.#host = createBackofficeFragmentDurableObject({
      name: "Reson8",
      state,
      env,
      configKey: CONFIG_KEY,
      parseStored: (raw) => storedReson8ConfigSchema.parse(raw),
      isConfigured: (stored): stored is StoredReson8Config =>
        Boolean(stored?.orgId && stored.apiKey),
      toSource: (stored) => ({ apiKey: stored.apiKey }),
      createRuntime: (source) => createReson8Server(source),
      getMigrationFragments: () => [],
      getHookFragments: () => [],
    });

    void state.blockConcurrencyWhile(async () => {
      await this.#host.initializeFromStored(await this.#host.loadStored());
    });
  }

  async getAdminConfig(): Promise<ConfigResponse> {
    const config = await this.#host.loadStored();
    return buildConfigResponse(config);
  }

  async resetAdminConfig(): Promise<ConfigResponse> {
    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.clearConfig();
    });
    return { configured: false };
  }

  async getRealtimeOriginDiagnostic(origin: string): Promise<Reson8RealtimeOriginDiagnostic> {
    const { source: config } = this.#host.requireConfigured(
      "Reson8 is not configured for this organisation.",
    );

    const tokenResponse = await fetch(`${RESON8_API_BASE_URL}/auth/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `ApiKey ${config.apiKey}`,
      },
    });

    if (!tokenResponse.ok) {
      return {
        origin,
        tokenStatus: tokenResponse.status,
        websocketStatus: null,
        websocketAccepted: false,
        message: `Reson8 token request failed with status ${tokenResponse.status}.`,
      };
    }

    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!token.access_token) {
      return {
        origin,
        tokenStatus: tokenResponse.status,
        websocketStatus: null,
        websocketAccepted: false,
        message: "Reson8 token request succeeded but did not return an access token.",
      };
    }

    let websocketResponse: Response;
    try {
      websocketResponse = await fetch(buildRealtimeDiagnosticUrl(), {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          Origin: origin,
          Upgrade: "websocket",
        },
      });
    } catch (error) {
      return {
        origin,
        tokenStatus: tokenResponse.status,
        websocketStatus: null,
        websocketAccepted: false,
        message:
          error instanceof Error
            ? `Realtime handshake failed before Reson8 returned a response: ${error.message}`
            : "Realtime handshake failed before Reson8 returned a response.",
      };
    }

    if (websocketResponse.webSocket) {
      websocketResponse.webSocket.accept();
      websocketResponse.webSocket.close(1000, "Origin diagnostic complete");

      return {
        origin,
        tokenStatus: tokenResponse.status,
        websocketStatus: 101,
        websocketAccepted: true,
        message: `Reson8 accepted the realtime websocket handshake for ${origin}.`,
      };
    }

    const websocketStatus = websocketResponse.status || null;

    return {
      origin,
      tokenStatus: tokenResponse.status,
      websocketStatus,
      websocketAccepted: false,
      message:
        websocketStatus === 403
          ? `Reson8 rejected the realtime websocket handshake for ${origin} (status 403). This origin likely needs to be allowlisted by Reson8.`
          : `Reson8 rejected the realtime websocket handshake for ${origin}${websocketStatus ? ` (status ${websocketStatus})` : ""}.`,
    };
  }

  async setAdminConfig(payload: unknown, orgId: string): Promise<ConfigResponse> {
    const normalizedOrgId = orgId.trim();
    if (!normalizedOrgId) {
      throw new Error("Missing organisation id.");
    }

    const existing = await this.#host.loadStored();
    this.#host.assertSameOrg(existing, normalizedOrgId);

    const parsed = setAdminConfigInputSchema.parse(payload);
    const apiKey = parsed.apiKey ?? existing?.apiKey ?? "";
    if (!apiKey) {
      throw new Error("Reson8 API key is required.");
    }

    const now = new Date().toISOString();
    const stored: StoredReson8Config = {
      orgId: normalizedOrgId,
      apiKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.storeAndInitialize(stored);
    });

    return buildConfigResponse(stored);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(request);
  }
}
