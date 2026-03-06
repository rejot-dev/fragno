import { DurableObject } from "cloudflare:workers";
import { migrate } from "@fragno-dev/db";
import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import type { ResendFragmentConfig } from "@fragno-dev/resend-fragment";
import { Resend as ResendClient } from "resend";
import { createResendServer, type ResendConfig, type ResendFragment } from "@/fragno/resend";
import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";

type StoredResendConfig = Omit<ResendConfig, "webhookSecret"> & {
  webhookBaseUrl?: string;
  webhookId?: string;
  webhookSecret?: string;
  createdAt: string;
  updatedAt: string;
};

type ConfigResponse = {
  configured: boolean;
  config?: {
    defaultFrom?: string | null;
    defaultReplyTo?: string[] | null;
    webhookBaseUrl?: string | null;
    webhookId?: string | null;
    apiKeyPreview?: string;
    webhookSecretPreview?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  webhook?: {
    ok: boolean;
    message: string;
  };
};

type WebhookResult = {
  ok: boolean;
  message: string;
  webhookId?: string;
  webhookSecret?: string;
};

const CONFIG_KEY = "resend-config";

const WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
] as const;

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

const normalizeReplyTo = (value?: string | string[]) => {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value : undefined;
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
};

const parseConfigInput = async (
  payload: unknown,
  existing?: StoredResendConfig | null,
): Promise<
  | {
      ok: true;
      data: {
        apiKey: string;
        defaultFrom: string;
        defaultReplyTo?: string[] | null;
        webhookBaseUrl?: string | null;
      };
    }
  | { ok: false; message: string }
> => {
  if (!payload || typeof payload !== "object") {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const payloadRecord = payload as Record<string, unknown>;
  const apiKeyRaw = typeof payloadRecord.apiKey === "string" ? payloadRecord.apiKey.trim() : "";
  const defaultFrom =
    typeof payloadRecord.defaultFrom === "string" ? payloadRecord.defaultFrom.trim() : "";
  const hasDefaultReplyTo = Object.prototype.hasOwnProperty.call(payloadRecord, "defaultReplyTo");
  const defaultReplyToRaw =
    typeof payloadRecord.defaultReplyTo === "string" || Array.isArray(payloadRecord.defaultReplyTo)
      ? payloadRecord.defaultReplyTo
      : undefined;
  const hasWebhookBaseUrl = Object.prototype.hasOwnProperty.call(payloadRecord, "webhookBaseUrl");
  const webhookBaseUrlRaw =
    typeof payloadRecord.webhookBaseUrl === "string" ? payloadRecord.webhookBaseUrl.trim() : "";

  const apiKey = apiKeyRaw || existing?.apiKey || "";
  const resolvedDefaultFrom = defaultFrom || existing?.defaultFrom || "";

  if (!apiKey) {
    return { ok: false, message: "Resend API key is required." };
  }

  if (!resolvedDefaultFrom) {
    return { ok: false, message: "Default from address is required." };
  }

  const webhookBaseUrl = hasWebhookBaseUrl ? webhookBaseUrlRaw || null : undefined;
  if (webhookBaseUrl) {
    try {
      new URL(webhookBaseUrl);
    } catch {
      return { ok: false, message: "Webhook base URL must be a valid absolute URL." };
    }
  }

  const parsedReplyTo = normalizeReplyTo(defaultReplyToRaw) ?? undefined;
  const defaultReplyTo = hasDefaultReplyTo ? (parsedReplyTo ?? null) : undefined;

  return {
    ok: true,
    data: {
      apiKey,
      defaultFrom: resolvedDefaultFrom,
      defaultReplyTo,
      webhookBaseUrl,
    },
  };
};

const buildConfigResponse = (config: StoredResendConfig | null): ConfigResponse => {
  if (!config) {
    return { configured: false };
  }

  const configured = Boolean(config.apiKey && config.webhookSecret && config.defaultFrom);

  return {
    configured,
    config: {
      defaultFrom: config.defaultFrom ?? null,
      defaultReplyTo: normalizeReplyTo(config.defaultReplyTo) ?? null,
      webhookBaseUrl: config.webhookBaseUrl ?? null,
      webhookId: config.webhookId ?? null,
      apiKeyPreview: maskSecret(config.apiKey),
      webhookSecretPreview: config.webhookSecret ? maskSecret(config.webhookSecret) : undefined,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    },
  };
};

const resolveWebhookUrl = (origin: string, orgId: string, baseUrl?: string) => {
  const resolvedOrigin = baseUrl ?? origin;
  const trimmed = resolvedOrigin.replace(/\/+$/, "");
  return `${trimmed}/api/resend/${orgId}/resend/webhook`;
};

const createWebhook = async (
  client: ResendClient,
  webhookUrl: string,
  orgId: string,
): Promise<WebhookResult> => {
  try {
    const { data, error } = await client.webhooks.create({
      endpoint: webhookUrl,
      events: [...WEBHOOK_EVENTS],
    });

    if (error) {
      return { ok: false, message: error.message };
    }

    if (!data) {
      return { ok: false, message: "Resend webhook did not return a payload." };
    }

    return {
      ok: true,
      message: "Webhook registered with Resend.",
      webhookId: data.id,
      webhookSecret: data.signing_secret,
    };
  } catch (error) {
    console.error("Resend webhook create failed", { orgId, webhookUrl, error });
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Resend webhook request failed.",
    };
  }
};

const updateWebhook = async (
  client: ResendClient,
  webhookId: string,
  webhookUrl: string,
  orgId: string,
): Promise<WebhookResult> => {
  try {
    const { error } = await client.webhooks.update(webhookId, {
      endpoint: webhookUrl,
      events: [...WEBHOOK_EVENTS],
      status: "enabled",
    });

    if (error) {
      return { ok: false, message: error.message };
    }

    return { ok: true, message: "Webhook updated with Resend." };
  } catch (error) {
    console.error("Resend webhook update failed", { orgId, webhookUrl, error });
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Resend webhook request failed.",
    };
  }
};

export class Resend extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #fragment: ResendFragment | null = null;
  #fragmentConfig: ResendFragmentConfig | null = null;
  #dispatcher: DurableHooksDispatcherDurableObjectHandler | null = null;
  #migrated = false;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
  }

  async #loadConfig() {
    const config = await this.#state.storage.get<StoredResendConfig>(CONFIG_KEY);
    return config ?? null;
  }

  #extractFragmentConfig(config: StoredResendConfig): ResendFragmentConfig | null {
    if (!config.webhookSecret) {
      return null;
    }

    return {
      apiKey: config.apiKey,
      webhookSecret: config.webhookSecret,
      defaultFrom: config.defaultFrom,
      defaultReplyTo: config.defaultReplyTo,
      defaultTags: config.defaultTags,
      defaultHeaders: config.defaultHeaders,
    };
  }

  #configsEqual(a: ResendFragmentConfig, b: ResendFragmentConfig) {
    const normalize = (value?: string | string[]) => {
      if (!value) {
        return [] as string[];
      }
      return Array.isArray(value) ? value : [value];
    };

    const replyToEqual = (() => {
      const aReply = normalize(a.defaultReplyTo);
      const bReply = normalize(b.defaultReplyTo);
      if (aReply.length !== bReply.length) {
        return false;
      }
      return aReply.every((entry, index) => entry === bReply[index]);
    })();

    return (
      a.apiKey === b.apiKey &&
      a.webhookSecret === b.webhookSecret &&
      a.defaultFrom === b.defaultFrom &&
      replyToEqual
    );
  }

  async #ensureFragment() {
    const stored = await this.#loadConfig();
    if (!stored) {
      return null;
    }

    const config = this.#extractFragmentConfig(stored);
    if (!config) {
      return null;
    }

    if (
      !this.#fragment ||
      !this.#fragmentConfig ||
      !this.#configsEqual(this.#fragmentConfig, config)
    ) {
      this.#fragment = createResendServer(config, this.#state);
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
            console.error("Resend hook processor error", error);
          },
        });
        this.#dispatcher = dispatcherFactory(this.#state, this.#env);
      } catch (error) {
        console.warn("Resend hook processor disabled", error);
        this.#dispatcher = null;
      }
    }

    return this.#fragment;
  }

  async alarm() {
    const fragment = await this.#ensureFragment();
    const dispatcher = this.#dispatcher;
    if (!fragment || !dispatcher?.alarm) {
      return;
    }

    await dispatcher.alarm();
  }

  async getAdminConfig(): Promise<ConfigResponse> {
    const config = await this.#loadConfig();
    return buildConfigResponse(config);
  }

  async setAdminConfig(payload: unknown, orgId: string, origin: string): Promise<ConfigResponse> {
    const existing = await this.#loadConfig();
    const parsed = await parseConfigInput(payload, existing);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }

    if (!orgId) {
      throw new Error("Missing organisation id.");
    }

    const now = new Date().toISOString();
    const defaultReplyTo =
      parsed.data.defaultReplyTo === undefined
        ? existing?.defaultReplyTo
        : (parsed.data.defaultReplyTo ?? undefined);
    const webhookBaseUrl =
      parsed.data.webhookBaseUrl === undefined
        ? existing?.webhookBaseUrl
        : (parsed.data.webhookBaseUrl ?? undefined);
    const stored: StoredResendConfig = {
      apiKey: parsed.data.apiKey,
      defaultFrom: parsed.data.defaultFrom,
      defaultReplyTo,
      webhookBaseUrl,
      webhookId: existing?.webhookId,
      webhookSecret: existing?.webhookSecret,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const client = new ResendClient(stored.apiKey);
    const webhookUrl = resolveWebhookUrl(origin, orgId, stored.webhookBaseUrl);

    let webhookResult: WebhookResult;

    if (stored.webhookId && stored.webhookSecret) {
      webhookResult = await updateWebhook(client, stored.webhookId, webhookUrl, orgId);
      if (!webhookResult.ok) {
        const fallback = await createWebhook(client, webhookUrl, orgId);
        if (fallback.ok) {
          webhookResult = fallback;
        }
      }
    } else {
      webhookResult = await createWebhook(client, webhookUrl, orgId);
    }

    if (webhookResult.ok) {
      stored.webhookId = webhookResult.webhookId ?? stored.webhookId;
      stored.webhookSecret = webhookResult.webhookSecret ?? stored.webhookSecret;
      await this.#state.storage.put(CONFIG_KEY, stored);

      try {
        await this.#ensureFragment();
      } catch (error) {
        console.log("Migration failed", { error });
        throw new Error("Failed to migrate Resend schema.");
      }

      return {
        ...buildConfigResponse(stored),
        webhook: { ok: webhookResult.ok, message: webhookResult.message },
      };
    }

    return {
      ...buildConfigResponse(existing ?? null),
      webhook: { ok: webhookResult.ok, message: webhookResult.message },
    };
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
    const fragment = await this.#ensureFragment();
    if (!fragment) {
      return jsonResponse(
        { message: "Resend is not configured for this organisation.", code: "NOT_CONFIGURED" },
        400,
      );
    }

    return fragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
