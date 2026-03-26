import { DurableObject } from "cloudflare:workers";

import { createReson8Server, type Reson8Fragment } from "@/fragno/reson8";

type StoredReson8Config = {
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

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

const maskSecret = (value: string) => {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "••••";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
};

const parseConfigInput = async (
  payload: unknown,
  existing?: StoredReson8Config | null,
): Promise<
  | {
      ok: true;
      data: {
        apiKey: string;
      };
    }
  | { ok: false; message: string }
> => {
  if (!payload || typeof payload !== "object") {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const record = payload as Record<string, unknown>;
  const apiKeyRaw = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  const apiKey = apiKeyRaw || existing?.apiKey || "";

  if (!apiKey) {
    return { ok: false, message: "Reson8 API key is required." };
  }

  return {
    ok: true,
    data: {
      apiKey,
    },
  };
};

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
  #fragment: Reson8Fragment | null = null;
  #fragmentApiKey: string | null = null;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#state = state;
  }

  async #loadConfig() {
    const config = await this.#state.storage.get<StoredReson8Config>(CONFIG_KEY);
    return config ?? null;
  }

  async #ensureFragment() {
    const stored = await this.#loadConfig();
    if (!stored?.apiKey) {
      return null;
    }

    if (!this.#fragment || this.#fragmentApiKey !== stored.apiKey) {
      this.#fragment = createReson8Server({ apiKey: stored.apiKey });
      this.#fragmentApiKey = stored.apiKey;
    }

    return this.#fragment;
  }

  async getAdminConfig(): Promise<ConfigResponse> {
    const config = await this.#loadConfig();
    return buildConfigResponse(config);
  }

  async getRealtimeOriginDiagnostic(origin: string): Promise<Reson8RealtimeOriginDiagnostic> {
    const config = await this.#loadConfig();
    if (!config?.apiKey) {
      throw new Error("Reson8 is not configured for this organisation.");
    }

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

  async setAdminConfig(payload: unknown, _orgId: string): Promise<ConfigResponse> {
    const existing = await this.#loadConfig();
    const parsed = await parseConfigInput(payload, existing);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }

    const now = new Date().toISOString();
    const stored: StoredReson8Config = {
      apiKey: parsed.data.apiKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#state.storage.put(CONFIG_KEY, stored);
    await this.#ensureFragment();

    return buildConfigResponse(stored);
  }

  async fetch(request: Request): Promise<Response> {
    const fragment = await this.#ensureFragment();
    if (!fragment) {
      return jsonResponse(
        {
          message: "Reson8 is not configured for this organisation.",
          code: "NOT_CONFIGURED",
        },
        400,
      );
    }

    return fragment.handler(request);
  }
}
