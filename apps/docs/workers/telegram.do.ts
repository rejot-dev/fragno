import { DurableObject } from "cloudflare:workers";
import { migrate } from "@fragno-dev/db";
import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import type { TelegramFragmentConfig } from "@fragno-dev/telegram-fragment";
import {
  createTelegramServer,
  type TelegramConfig,
  type TelegramFragment,
} from "@/fragno/telegram";

type StoredTelegramConfig = TelegramConfig & {
  webhookBaseUrl?: string;
  createdAt: string;
  updatedAt: string;
};

type ConfigResponse = {
  configured: boolean;
  config?: {
    botUsername?: string | null;
    apiBaseUrl?: string | null;
    webhookBaseUrl?: string | null;
    botTokenPreview?: string;
    webhookSecretTokenPreview?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  webhook?: {
    ok: boolean;
    message: string;
  };
};

const CONFIG_KEY = "telegram-config";

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
): Promise<
  { ok: true; data: TelegramConfig & { webhookBaseUrl?: string } } | { ok: false; message: string }
> => {
  if (!payload || typeof payload !== "object") {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const payloadRecord = payload as Record<string, unknown>;
  const botToken = typeof payloadRecord.botToken === "string" ? payloadRecord.botToken.trim() : "";
  const webhookSecretToken =
    typeof payloadRecord.webhookSecretToken === "string"
      ? payloadRecord.webhookSecretToken.trim()
      : "";
  const botUsernameRaw =
    typeof payloadRecord.botUsername === "string" ? payloadRecord.botUsername.trim() : "";
  const apiBaseUrlRaw =
    typeof payloadRecord.apiBaseUrl === "string" ? payloadRecord.apiBaseUrl.trim() : "";
  const webhookBaseUrlRaw =
    typeof payloadRecord.webhookBaseUrl === "string" ? payloadRecord.webhookBaseUrl.trim() : "";

  if (!botToken) {
    return { ok: false, message: "Bot token is required." };
  }
  if (!webhookSecretToken) {
    return { ok: false, message: "Webhook secret token is required." };
  }

  const botUsername = botUsernameRaw ? botUsernameRaw.replace(/^@/, "") : undefined;
  const apiBaseUrl = apiBaseUrlRaw || undefined;

  if (apiBaseUrl) {
    try {
      new URL(apiBaseUrl);
    } catch {
      return { ok: false, message: "API base URL must be a valid absolute URL." };
    }
  }

  const webhookBaseUrl = webhookBaseUrlRaw || undefined;
  if (webhookBaseUrl) {
    try {
      new URL(webhookBaseUrl);
    } catch {
      return { ok: false, message: "Webhook base URL must be a valid absolute URL." };
    }
  }

  return {
    ok: true,
    data: {
      botToken,
      webhookSecretToken,
      botUsername,
      apiBaseUrl,
      webhookBaseUrl,
    },
  };
};

const buildConfigResponse = (config: StoredTelegramConfig | null): ConfigResponse => {
  if (!config) {
    return { configured: false };
  }

  return {
    configured: true,
    config: {
      botUsername: config.botUsername ?? null,
      apiBaseUrl: config.apiBaseUrl ?? null,
      webhookBaseUrl: config.webhookBaseUrl ?? null,
      botTokenPreview: maskSecret(config.botToken),
      webhookSecretTokenPreview: maskSecret(config.webhookSecretToken),
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    },
  };
};

const resolveWebhookUrl = (origin: string, orgId: string, baseUrl?: string) => {
  const resolvedOrigin = baseUrl ?? origin;
  const trimmed = resolvedOrigin.replace(/\/+$/, "");
  return `${trimmed}/api/telegram/${orgId}/telegram/webhook`;
};

const setTelegramWebhook = async (config: TelegramConfig, webhookUrl: string) => {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: config.webhookSecretToken,
    }),
  });

  let payload: { ok?: boolean; description?: string } | null = null;
  try {
    payload = (await response.json()) as { ok?: boolean; description?: string };
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok) {
    const message =
      payload?.description ?? `Telegram API rejected the webhook (${response.status}).`;
    return { ok: false, message };
  }

  return { ok: true, message: payload.description ?? "Webhook registered with Telegram." };
};

export class Telegram extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #fragment: TelegramFragment | null = null;
  #fragmentConfig: TelegramFragmentConfig | null = null;
  #dispatcher: DurableHooksDispatcherDurableObjectHandler | null = null;
  #migrated = false;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
  }

  async #loadConfig() {
    const config = await this.#state.storage.get<StoredTelegramConfig>(CONFIG_KEY);
    return config ?? null;
  }

  #extractFragmentConfig(config: StoredTelegramConfig): TelegramFragmentConfig {
    return {
      botToken: config.botToken,
      webhookSecretToken: config.webhookSecretToken,
      botUsername: config.botUsername,
      apiBaseUrl: config.apiBaseUrl,
    };
  }

  #configsEqual(a: TelegramFragmentConfig, b: TelegramFragmentConfig) {
    return (
      a.botToken === b.botToken &&
      a.webhookSecretToken === b.webhookSecretToken &&
      a.botUsername === b.botUsername &&
      a.apiBaseUrl === b.apiBaseUrl
    );
  }

  async #ensureFragment() {
    const stored = await this.#loadConfig();
    if (!stored) {
      return null;
    }

    const config = this.#extractFragmentConfig(stored);

    if (
      !this.#fragment ||
      !this.#fragmentConfig ||
      !this.#configsEqual(this.#fragmentConfig, config)
    ) {
      this.#fragment = createTelegramServer(config, this.#state);
      this.#fragmentConfig = config;
      this.#migrated = false;
      this.#dispatcher = null;
    }

    if (!this.#migrated && this.#fragment) {
      await migrate(this.#fragment);
      this.#migrated = true;
    }

    if (this.#fragment && !this.#dispatcher) {
      try {
        const dispatcherFactory = createDurableHooksProcessor([this.#fragment], {
          onProcessError: (error) => {
            console.error("Telegram hook processor error", error);
          },
        });
        this.#dispatcher = dispatcherFactory(this.#state, this.#env);
      } catch (error) {
        console.warn("Telegram hook processor disabled", error);
        this.#dispatcher = null;
      }
    }

    return this.#fragment;
  }

  async alarm() {
    if (this.#dispatcher?.alarm) {
      await this.#dispatcher.alarm();
    }
  }

  async getAdminConfig(): Promise<ConfigResponse> {
    const config = await this.#loadConfig();
    return buildConfigResponse(config);
  }

  async setAdminConfig(payload: unknown, orgId: string, origin: string): Promise<ConfigResponse> {
    const parsed = await parseConfigInput(payload);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }

    const now = new Date().toISOString();
    const existing = await this.#loadConfig();
    const stored: StoredTelegramConfig = {
      ...parsed.data,
      webhookBaseUrl: parsed.data.webhookBaseUrl ?? existing?.webhookBaseUrl,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#state.storage.put(CONFIG_KEY, stored);

    try {
      await this.#ensureFragment();
    } catch (error) {
      console.log("Migration failed", { error });
      throw new Error("Failed to migrate Telegram schema.");
    }

    if (!orgId) {
      throw new Error("Missing organisation id.");
    }

    const webhookUrl = resolveWebhookUrl(origin, orgId, stored.webhookBaseUrl);
    const webhookResult = await setTelegramWebhook(stored, webhookUrl);

    return { ...buildConfigResponse(stored), webhook: webhookResult };
  }

  async fetch(request: Request): Promise<Response> {
    const fragment = await this.#ensureFragment();
    if (!fragment) {
      return jsonResponse(
        { message: "Telegram is not configured for this organisation.", code: "NOT_CONFIGURED" },
        400,
      );
    }

    return fragment.handler(request);
  }
}
