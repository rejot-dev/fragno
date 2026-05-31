import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { TelegramFragmentConfig } from "@fragno-dev/telegram-fragment";
import type { TelegramMessageHookPayload } from "@fragno-dev/telegram-fragment";

import type { TelegramAutomationFileMetadata } from "@/fragno/bash-runtime/telegram-bash-runtime";
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

type TelegramRuntime =
  | { configured: false }
  | {
      configured: true;
      stored: StoredTelegramConfig;
      config: TelegramFragmentConfig;
      fragment: TelegramFragment;
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
const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";

const maskSecret = (value: string) => {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "••••";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
};

const isAbsoluteUrl = (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const setAdminConfigInputSchema = z.object({
  orgId: z.string().trim().min(1, "Missing organisation id."),
  botToken: z.string().trim().min(1, "Bot token is required."),
  webhookSecretToken: z.string().trim().min(1, "Webhook secret token is required."),
  botUsername: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, "") || undefined)
    .optional(),
  apiBaseUrl: z
    .string()
    .trim()
    .transform((value) => value || undefined)
    .refine((value) => !value || isAbsoluteUrl(value), {
      message: "API base URL must be a valid absolute URL.",
    })
    .optional(),
  webhookBaseUrl: z
    .string()
    .trim()
    .transform((value) => value || undefined)
    .refine((value) => !value || isAbsoluteUrl(value), {
      message: "Webhook base URL must be a valid absolute URL.",
    })
    .optional(),
});

const telegramApiResponseSchema = z.object({
  ok: z.boolean().optional(),
  description: z.string().optional(),
});

const telegramGetFileResponseSchema = telegramApiResponseSchema.extend({
  result: z.unknown().optional(),
});

const telegramFileMetadataPayloadSchema = z.object({
  file_id: z
    .string()
    .trim()
    .transform((value) => value || undefined)
    .optional(),
  file_unique_id: z
    .string()
    .trim()
    .transform((value) => value || undefined)
    .optional(),
  file_path: z
    .string()
    .trim()
    .transform((value) => value || undefined)
    .optional(),
  file_size: z.number().refine(Number.isFinite).nullable().optional(),
});

const automationFileInputSchema = z.object({
  fileId: z.string().trim().min(1, "Telegram automation file access requires a non-empty fileId."),
});

const automationReplyInputSchema = z.object({
  chatId: z.string().trim().min(1, "chatId and text are required."),
  text: z.string().refine((value) => value.trim().length > 0, {
    message: "chatId and text are required.",
  }),
});

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

const normalizeTelegramApiBaseUrl = (apiBaseUrl?: string | null) =>
  (apiBaseUrl ?? DEFAULT_TELEGRAM_API_BASE_URL).replace(/\/+$/, "");

const resolveTelegramFileDownloadUrl = (
  config: Pick<TelegramConfig, "botToken" | "apiBaseUrl">,
  filePath: string,
) => {
  const normalizedPath = filePath.trim().replace(/^\/+/, "");
  if (!normalizedPath) {
    throw new Error("Telegram file metadata did not include a file path.");
  }

  return `${normalizeTelegramApiBaseUrl(config.apiBaseUrl)}/file/bot${config.botToken}/${normalizedPath}`;
};

const normalizeTelegramAutomationFile = (
  fileId: string,
  payload: unknown,
): TelegramAutomationFileMetadata => {
  const result = telegramFileMetadataPayloadSchema.safeParse(payload);
  const metadata = result.success ? result.data : {};

  return {
    fileId: metadata.file_id ?? fileId,
    fileUniqueId: metadata.file_unique_id ?? null,
    filePath: metadata.file_path ?? null,
    fileSize: metadata.file_size ?? null,
  };
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

  const payloadResult = telegramApiResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  const payload = payloadResult.success ? payloadResult.data : null;

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
  #host: FragmentDurableObjectHost<TelegramFragmentConfig, TelegramFragment>;
  #runtime: TelegramRuntime = { configured: false };

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
    this.#host = createFragmentDurableObjectHost({
      name: "Telegram",
      state,
      env,
      createRuntime: (config) =>
        createTelegramServer(config, state, {
          hooks: {
            onMessageReceived: this.#handleMessageReceived.bind(this),
          },
        }),
      onProcessError: (error) => {
        console.error("Telegram hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("Telegram hook processor disabled", error);
      },
    });

    void state.blockConcurrencyWhile(async () => {
      try {
        const stored = await this.#loadConfig();
        if (!stored) {
          this.#runtime = { configured: false };
          return;
        }

        this.#getStoredOrgId(stored, { required: true });
        this.#runtime = {
          configured: true,
          stored,
          config: stored,
          fragment: await this.#host.initialize(stored),
        };
      } catch (error) {
        console.log("Migration failed", { error });
        throw error;
      }
    });
  }

  async #loadConfig() {
    const config = await this.#state.storage.get<StoredTelegramConfig>(CONFIG_KEY);
    return config ?? null;
  }

  #getStoredOrgId(config: StoredTelegramConfig | null, options: { required: true }): string;
  #getStoredOrgId(
    config: StoredTelegramConfig | null,
    options?: { required?: false },
  ): string | null;
  #getStoredOrgId(config: StoredTelegramConfig | null, options: { required?: boolean } = {}) {
    const storedOrgId = typeof config?.orgId === "string" ? config.orgId.trim() : "";
    if (storedOrgId) {
      return storedOrgId;
    }

    if (options.required) {
      throw new Error("Stored Telegram config is missing an organisation id.");
    }

    return null;
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

  async #handleMessageReceived(payload: TelegramMessageHookPayload) {
    const runtime = this.#getConfiguredRuntime();
    if (!runtime) {
      console.warn("Ignoring Telegram message because automations routing is unavailable", {
        orgId: null,
        updateId: payload.updateId,
        messageId: payload.messageId,
      });
      return;
    }

    const orgId = this.#getStoredOrgId(runtime.stored, { required: true });
    const automationsDo = this.#env.AUTOMATIONS.get(this.#env.AUTOMATIONS.idFromName(orgId));

    await automationsDo.triggerIngestEvent(buildTelegramAutomationEvent(orgId, payload));
  }

  async #setRuntimeFromStoredConfig(stored: StoredTelegramConfig | null) {
    if (!stored) {
      this.#runtime = { configured: false };
      return;
    }

    this.#getStoredOrgId(stored, { required: true });
    const fragment = await this.#host.initialize(stored);
    this.#runtime = {
      configured: true,
      stored,
      config: stored,
      fragment,
    };
  }

  #getConfiguredRuntime() {
    return this.#runtime.configured ? this.#runtime : null;
  }

  #getConfiguredRuntimeOrThrow() {
    const runtime = this.#getConfiguredRuntime();
    if (!runtime) {
      throw new Error("Telegram is unavailable.");
    }

    return runtime;
  }

  async getAutomationFile(input: { fileId: string }): Promise<TelegramAutomationFileMetadata> {
    const { config } = this.#getConfiguredRuntimeOrThrow();
    const { fileId } = automationFileInputSchema.parse(input);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(
        `${normalizeTelegramApiBaseUrl(config.apiBaseUrl)}/bot${config.botToken}/getFile`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ file_id: fileId }),
          signal: controller.signal,
        },
      );

      const payloadResult = telegramGetFileResponseSchema.safeParse(
        await response.json().catch(() => null),
      );
      const payload = payloadResult.success ? payloadResult.data : null;

      if (!response.ok || !payload?.ok) {
        throw new Error(
          payload?.description ?? `Telegram API rejected getFile (${response.status}).`,
        );
      }

      return normalizeTelegramAutomationFile(fileId, payload.result);
    } catch (error) {
      if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
        throw new Error("Telegram API request timed out while resolving file metadata.");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async downloadAutomationFile(input: { fileId: string }): Promise<Response> {
    const { config } = this.#getConfiguredRuntimeOrThrow();
    const metadata = await this.getAutomationFile(input);
    if (!metadata.filePath) {
      throw new Error("Telegram file metadata did not include a file path.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(resolveTelegramFileDownloadUrl(config, metadata.filePath), {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Telegram file download failed with status ${response.status}.`);
      }

      return response;
    } catch (error) {
      if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
        throw new Error("Telegram API request timed out while downloading file bytes.");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async alarm() {
    await this.#host.alarm();
  }

  async sendAutomationReply(input: {
    chatId: string;
    text: string;
  }): Promise<{ ok: boolean; queued: boolean }> {
    const runtime = this.#getConfiguredRuntimeOrThrow();
    const { chatId, text } = automationReplyInputSchema.parse(input);

    const response = await runtime.fragment.callRoute("POST", "/chats/:chatId/send", {
      pathParams: { chatId },
      body: { text },
    });

    if (response.type !== "json" || !response.data.ok) {
      throw new Error("Failed to queue Telegram reply.");
    }

    return response.data;
  }

  async getAdminConfig(): Promise<ConfigResponse> {
    const config = await this.#loadConfig();
    return buildConfigResponse(config);
  }

  async setAdminConfig(payload: unknown, origin: string): Promise<ConfigResponse> {
    const parsed = setAdminConfigInputSchema.parse(payload);
    const normalizedOrgId = parsed.orgId;

    const existing = await this.#loadConfig();
    const existingOrgId = this.#getStoredOrgId(existing);
    if (existingOrgId && existingOrgId !== normalizedOrgId) {
      throw new Error(
        `Telegram Durable Object is already bound to organisation "${existingOrgId}".`,
      );
    }

    const now = new Date().toISOString();
    const stored: StoredTelegramConfig = {
      ...parsed,
      orgId: normalizedOrgId,
      webhookBaseUrl: parsed.webhookBaseUrl ?? existing?.webhookBaseUrl,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#state.storage.put(CONFIG_KEY, stored);

    try {
      await this.#state.blockConcurrencyWhile(async () => {
        await this.#setRuntimeFromStoredConfig(stored);
      });
    } catch (error) {
      console.log("Migration failed", { error });
      throw new Error("Failed to migrate Telegram schema.");
    }

    const webhookUrl = resolveWebhookUrl(origin, normalizedOrgId, stored.webhookBaseUrl);
    const webhookResult = await setTelegramWebhook(stored, webhookUrl, normalizedOrgId);

    return { ...buildConfigResponse(stored), webhook: webhookResult };
  }

  async getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse> {
    const runtime = this.#getConfiguredRuntime();
    if (!runtime) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    return await loadDurableHookQueue(runtime.fragment, options);
  }

  async fetch(request: Request): Promise<Response> {
    const runtime = this.#getConfiguredRuntime();
    if (runtime) {
      this.#assertRequestOrgIdMatchesConfig(request, runtime.stored);
    }

    if (!runtime) {
      return Response.json(
        {
          message: "Telegram is not configured for this organisation.",
          code: "NOT_CONFIGURED",
        },
        { status: 400 },
      );
    }

    return this.#host.fetch(runtime.fragment, request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
