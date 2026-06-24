import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { Reson8Object } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { AUTOMATION_SYSTEM_ACTOR } from "@/fragno/automation/contracts";
import { reson8ConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/reson8";
import { createReson8Server, type Reson8Fragment } from "@/fragno/reson8";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
  type BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";

type StoredReson8Config = {
  scope: Extract<BackofficeContextScope, { kind: "org" }>;
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
  scope: z.object({
    kind: z.literal("org"),
    orgId: z.string().trim().min(1, "Stored Reson8 config is missing an organisation id."),
  }),
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

export class InMemoryReson8Object implements Reson8Object {
  #state: BackofficeObjectState;
  #runtime: BackofficeRuntimeServices;
  #host: BackofficeFragmentDurableObject<StoredReson8Config, Reson8Source, Reson8Fragment>;
  #fetch: typeof fetch;

  constructor({
    state,
    env,
    runtime,
    fetch: fetchImpl = fetch,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
    fetch?: typeof fetch;
  }) {
    this.#state = state;
    this.#runtime = runtime;
    this.#fetch = fetchImpl;
    this.#host = createBackofficeFragmentDurableObject({
      name: "Reson8",
      state,
      env,
      configKey: CONFIG_KEY,
      parseStored: (raw) => storedReson8ConfigSchema.parse(raw),
      isConfigured: (stored): stored is StoredReson8Config =>
        Boolean(stored?.scope && stored.apiKey),
      toSource: (stored) => ({ apiKey: stored.apiKey }),
      createRuntime: (source) => createReson8Server(source),
      getMigrationFragments: () => [],
      getHookFragments: () => [],
      outbox: {
        dispatch: async (item, { stored }) => {
          if (item.type !== "capability.configured") {
            return;
          }

          const { scope } = stored;
          await this.#runtime.objects.automations.for(scope).ingestEvent({
            id: item.id,
            scope,
            source: "reson8",
            eventType: "capability.configured",
            occurredAt: item.createdAt,
            payload: {
              capabilityId: "reson8",
              capabilityLabel: "Reson8",
            },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: scope.orgId,
              capabilityId: "reson8",
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

    const tokenResponse = await this.#fetch(`${RESON8_API_BASE_URL}/auth/token`, {
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
      websocketResponse = await this.#fetch(buildRealtimeDiagnosticUrl(), {
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
    const scope = { kind: "org" as const, orgId: normalizedOrgId };
    this.#host.assertSameScope(existing, scope);

    const parsed = setAdminConfigInputSchema.parse(payload);
    const apiKey = parsed.apiKey ?? existing?.apiKey ?? "";
    if (!apiKey) {
      throw new Error("Reson8 API key is required.");
    }

    const now = new Date().toISOString();
    const stored: StoredReson8Config = {
      scope,
      apiKey,
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

    return buildConfigResponse(stored);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(request);
  }
}

export class Reson8 extends DurableObject<CloudflareEnv> implements Reson8Object {
  #object: InMemoryReson8Object;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryReson8Object({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async alarm() {
    await this.#object.alarm();
  }

  async getAdminConfig(): Promise<ConfigResponse> {
    return await this.#object.getAdminConfig();
  }

  async resetAdminConfig(): Promise<ConfigResponse> {
    return await this.#object.resetAdminConfig();
  }

  async getRealtimeOriginDiagnostic(origin: string): Promise<Reson8RealtimeOriginDiagnostic> {
    return await this.#object.getRealtimeOriginDiagnostic(origin);
  }

  async setAdminConfig(payload: unknown, orgId: string): Promise<ConfigResponse> {
    return await this.#object.setAdminConfig(payload, orgId);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
