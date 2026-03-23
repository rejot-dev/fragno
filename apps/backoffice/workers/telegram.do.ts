import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import { DurableObject } from "cloudflare:workers";

import { migrate } from "@fragno-dev/db";
import type { TelegramFragmentConfig } from "@fragno-dev/telegram-fragment";
import type { TelegramMessageHookPayload } from "@fragno-dev/telegram-fragment";

import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
import {
  buildTelegramAutomationEvent,
  createTelegramServer,
  type TelegramConfig,
  type TelegramFragment,
} from "@/fragno/telegram";

type StoredTelegramConfig = TelegramConfig & {
  orgId: string;
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
      return {
        ok: false,
        message: "API base URL must be a valid absolute URL.",
      };
    }
  }

  const webhookBaseUrl = webhookBaseUrlRaw || undefined;
  if (webhookBaseUrl) {
    try {
      new URL(webhookBaseUrl);
    } catch {
      return {
        ok: false,
        message: "Webhook base URL must be a valid absolute URL.",
      };
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

const setTelegramWebhook = async (config: TelegramConfig, webhookUrl: string, orgId: string) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response: Response;

  try {
    response = await fetch(`https://api.telegram.org/bot${config.botToken}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: config.webhookSecretToken,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error && typeof error === "object" && "name" in error) {
      const name = String((error as { name?: string }).name);
      if (name === "AbortError") {
        console.warn("Telegram webhook request timed out", {
          orgId,
          webhookUrl,
        });
        return { ok: false, message: "Telegram API request timed out" };
      }
    }
    console.error("Telegram webhook request failed", {
      orgId,
      webhookUrl,
      error,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  let payload: { ok?: boolean; description?: string } | null = null;
  try {
    payload = (await response.json()) as { ok?: boolean; description?: string };
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok) {
    const message =
      payload?.description ?? `Telegram API rejected the webhook (${response.status}).`;
    console.warn("Telegram webhook rejected", {
      orgId,
      webhookUrl,
      status: response.status,
      description: payload?.description ?? null,
    });
    return { ok: false, message };
  }

  return {
    ok: true,
    message: payload.description ?? "Webhook registered with Telegram.",
  };
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

  #getStoredOrgId(config: StoredTelegramConfig | null) {
    if (!config || typeof config.orgId !== "string") {
      return null;
    }

    const storedOrgId = config.orgId.trim();
    return storedOrgId ? storedOrgId : null;
  }

  #assertRequestOrgIdMatchesConfig(request: Request, config: StoredTelegramConfig) {
    const storedOrgId = this.#getStoredOrgId(config);
    if (!storedOrgId) {
      return;
    }

    const requestOrgId = new URL(request.url).searchParams.get("orgId")?.trim();
    if (!requestOrgId) {
      return;
    }

    if (requestOrgId !== storedOrgId) {
      throw new Error(`Telegram Durable Object is already bound to organisation "${storedOrgId}".`);
    }
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

  async #handleMessageReceived(payload: TelegramMessageHookPayload) {
    const config = await this.#loadConfig();
    const orgId = this.#getStoredOrgId(config);
    if (!orgId) {
      console.warn("Ignoring Telegram message because automations routing is unavailable", {
        orgId,
        updateId: payload.updateId,
        messageId: payload.messageId,
      });
      return;
    }

    const automationsDo = this.#env.AUTOMATIONS.get(this.#env.AUTOMATIONS.idFromName(orgId));

    await automationsDo.triggerIngestEvent(buildTelegramAutomationEvent(orgId, payload));
  }

  async #ensureFragment() {
    const stored = await this.#loadConfig();
    if (!stored) {
      return null;
    }

    const orgId = this.#getStoredOrgId(stored);
    if (!orgId) {
      return null;
    }

    const config = this.#extractFragmentConfig(stored);

    if (
      !this.#fragment ||
      !this.#fragmentConfig ||
      !this.#configsEqual(this.#fragmentConfig, config)
    ) {
      this.#fragment = createTelegramServer(config, this.#state, {
        hooks: {
          onMessageReceived: this.#handleMessageReceived.bind(this),
        },
      });
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

  async sendAutomationReply(input: {
    chatId: string;
    text: string;
  }): Promise<{ ok: boolean; queued: boolean }> {
    const fragment = await this.#ensureFragment();
    if (!fragment) {
      throw new Error("Telegram is unavailable.");
    }

    const chatId = input.chatId.trim();
    const text = input.text;
    if (!chatId || !text.trim()) {
      throw new Error("chatId and text are required.");
    }

    const response = await fragment.callRoute("POST", "/chats/:chatId/send", {
      pathParams: { chatId },
      body: { text },
    });

    if (response.type !== "json" || !response.data.ok) {
      throw new Error("Failed to queue Telegram reply.");
    }

    await this.#dispatcher?.notify?.({
      source: "request",
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });

    return response.data;
  }

  async getAdminConfig(): Promise<ConfigResponse> {
    const config = await this.#loadConfig();
    return buildConfigResponse(config);
  }

  async setAdminConfig(payload: unknown, origin: string): Promise<ConfigResponse> {
    const parsed = await parseConfigInput(payload);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }

    const record = payload as Record<string, unknown>;
    const normalizedOrgId = typeof record.orgId === "string" ? record.orgId.trim() : "";
    if (!normalizedOrgId) {
      throw new Error("Missing organisation id.");
    }

    const existing = await this.#loadConfig();
    const existingOrgId = this.#getStoredOrgId(existing);
    if (existingOrgId && existingOrgId !== normalizedOrgId) {
      throw new Error(
        `Telegram Durable Object is already bound to organisation "${existingOrgId}".`,
      );
    }

    const now = new Date().toISOString();
    const stored: StoredTelegramConfig = {
      ...parsed.data,
      orgId: normalizedOrgId,
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

    const webhookUrl = resolveWebhookUrl(origin, normalizedOrgId, stored.webhookBaseUrl);
    const webhookResult = await setTelegramWebhook(stored, webhookUrl, normalizedOrgId);

    return { ...buildConfigResponse(stored), webhook: webhookResult };
  }

  async getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse> {
    const fragment = await this.#ensureFragment();
    if (!fragment) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    return await loadDurableHookQueue(fragment, options);
  }

  async fetch(request: Request): Promise<Response> {
    const config = await this.#loadConfig();
    if (config) {
      this.#assertRequestOrgIdMatchesConfig(request, config);
    }

    const fragment = await this.#ensureFragment();
    if (!fragment) {
      return jsonResponse(
        {
          message: "Telegram is not configured for this organisation.",
          code: "NOT_CONFIGURED",
        },
        400,
      );
    }

    return fragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
