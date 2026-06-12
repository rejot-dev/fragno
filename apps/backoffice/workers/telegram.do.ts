import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { TelegramFragmentConfig } from "@fragno-dev/telegram-fragment";

import { AUTOMATION_SYSTEM_ACTOR } from "@/fragno/automation/contracts";
import { telegramConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/telegram";
import { type DurableHookQueueOptions } from "@/fragno/durable-hooks";
import type { TelegramAutomationFileMetadata } from "@/fragno/runtime-tools/families/telegram-runtime";
import {
  buildTelegramAutomationEvent,
  createTelegramServer,
  type TelegramConfig,
  type TelegramFragment,
} from "@/fragno/telegram";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
} from "./lib/backoffice-fragment-durable-object";

type StoredTelegramConfig = TelegramConfig & {
  orgId: string;
  webhookBaseUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type TelegramAdminConfigResponse = {
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

const setAdminConfigInputSchema = telegramConfigureInputSchema.extend({
  orgId: z.string().trim().min(1, "Missing organisation id."),
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

function buildConfigResponse(
  config: null,
): Extract<TelegramAdminConfigResponse, { configured: false }>;
function buildConfigResponse(
  config: StoredTelegramConfig,
): Extract<TelegramAdminConfigResponse, { configured: true }>;
function buildConfigResponse(config: StoredTelegramConfig | null): TelegramAdminConfigResponse;
function buildConfigResponse(config: StoredTelegramConfig | null): TelegramAdminConfigResponse {
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
}

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
    response = await fetch(
      `${normalizeTelegramApiBaseUrl(config.apiBaseUrl)}/bot${config.botToken}/setWebhook`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: config.webhookSecretToken,
        }),
        signal: controller.signal,
      },
    );
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
  #host: BackofficeFragmentDurableObject<
    StoredTelegramConfig,
    TelegramFragmentConfig,
    TelegramFragment
  >;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
    this.#host = createBackofficeFragmentDurableObject({
      name: "Telegram",
      state,
      env,
      toSource: (stored) => ({
        botToken: stored.botToken,
        webhookSecretToken: stored.webhookSecretToken,
        botUsername: stored.botUsername,
        apiBaseUrl: stored.apiBaseUrl,
      }),
      createRuntime: (config) =>
        createTelegramServer(config, state, {
          hooks: {
            onMessageReceived: async (payload) => {
              const runtime = this.#host.getConfigured();
              if (!runtime) {
                console.warn(
                  "Ignoring Telegram message because automations routing is unavailable",
                  {
                    orgId: null,
                    updateId: payload.updateId,
                    messageId: payload.messageId,
                  },
                );
                return;
              }

              const orgId = this.#host.getStoredOrgId(runtime.stored);
              if (!orgId) {
                throw new Error("Stored Telegram config is missing an organisation id.");
              }

              const automationsDo = this.#env.AUTOMATIONS.get(
                this.#env.AUTOMATIONS.idFromName(orgId),
              );

              await automationsDo.triggerIngestEvent(buildTelegramAutomationEvent(orgId, payload));
            },
          },
        }),
      outbox: {
        dispatch: async (item, { env, stored }) => {
          if (item.type !== "capability.configured") {
            return;
          }

          await env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(stored.orgId)).ingestEvent({
            id: item.id,
            orgId: stored.orgId,
            source: "telegram",
            eventType: "capability.configured",
            occurredAt: item.createdAt,
            payload: {
              capabilityId: "telegram",
              capabilityLabel: "Telegram",
            },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: stored.orgId,
              capabilityId: "telegram",
            },
          });
        },
      },
    });

    void state.blockConcurrencyWhile(async () => {
      await this.#host.initializeFromStored(await this.#host.loadStored());
    });
  }

  async getAutomationFile(input: { fileId: string }): Promise<TelegramAutomationFileMetadata> {
    const { source: config } = this.#host.requireConfigured();
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
    const { source: config } = this.#host.requireConfigured();
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

  async getAdminConfig(): Promise<TelegramAdminConfigResponse> {
    const config = await this.#host.loadStored();
    return buildConfigResponse(config);
  }

  async resetAdminConfig(): Promise<TelegramAdminConfigResponse> {
    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.clearConfig();
    });
    return { configured: false };
  }

  async setAdminConfig(payload: unknown, origin: string): Promise<TelegramAdminConfigResponse> {
    const parsed = setAdminConfigInputSchema.parse(payload);
    const normalizedOrgId = parsed.orgId;

    const existing = await this.#host.loadStored();
    this.#host.assertSameOrg(existing, normalizedOrgId);

    const now = new Date().toISOString();
    const createdAt = existing?.createdAt ?? now;
    const stored: StoredTelegramConfig = {
      ...parsed,
      orgId: normalizedOrgId,
      webhookBaseUrl: parsed.webhookBaseUrl,
      createdAt,
      updatedAt: now,
    };

    try {
      await this.#state.blockConcurrencyWhile(async () => {
        await this.#host.storeAndInitialize(stored);
        await this.#host.dispatch({
          id: `telegram:capability.configured:${normalizedOrgId}:${createdAt}`,
          type: "capability.configured",
          createdAt,
        });
      });
    } catch {
      throw new Error("Failed to migrate Telegram schema.");
    }

    const webhookUrl = resolveWebhookUrl(origin, normalizedOrgId, stored.webhookBaseUrl);
    const webhookResult = await setTelegramWebhook(stored, webhookUrl, normalizedOrgId);

    return {
      configured: true,
      config: {
        botUsername: stored.botUsername ?? null,
        apiBaseUrl: stored.apiBaseUrl ?? null,
        webhookBaseUrl: stored.webhookBaseUrl ?? null,
        botTokenPreview: maskSecret(stored.botToken),
        webhookSecretTokenPreview: maskSecret(stored.webhookSecretToken),
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      },
      webhook: webhookResult,
    };
  }

  getDurableHookRepository() {
    return this.#host.getDurableHookRepository<DurableHookQueueOptions>(({ runtime }) => runtime);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(request);
  }
}
