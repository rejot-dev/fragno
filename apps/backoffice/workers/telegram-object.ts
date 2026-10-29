import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  backofficeContextScopesEqual,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

import type { TelegramApi, TelegramFragmentConfig } from "@fragno-dev/telegram-fragment";

import { authorizeBackofficeFragmentRequest } from "@/backoffice-runtime/fragment-http-authorization";
import { createBackofficeFragmentHttpTransport } from "@/backoffice-runtime/fragment-http-transport";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  backofficeContextScopeFromDurableObjectId,
  backofficeObjectScopeFromContextScope,
  type TelegramCommands,
  type WebhookRegistrationCheck,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  createTelegramAutomationFileResponse,
  telegramAutomationFileIdFromDownloadPath,
  type TelegramAutomationFileMetadata,
} from "@/backoffice-runtime/telegram-file-response";
import { telegramConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/telegram";
import { type DurableHookQueueOptions } from "@/fragno/durable-hooks";
import {
  recordIntegrationSlotChange,
  type IntegrationSlotOutboxItem,
} from "@/fragno/runtime-tools/families/integrations/integration-events";
import { telegramConnectionIdentity } from "@/fragno/runtime-tools/families/integrations/telegram-integration";
import {
  buildTelegramAutomationEvent,
  createTelegramServer,
  type TelegramConfig,
  type TelegramFragment,
} from "@/fragno/telegram";

import type {
  BackofficeFragmentDurableObject,
  BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

type TelegramObjectEnv = {
  DOCS_PUBLIC_BASE_URL?: string;
  BACKOFFICE_INTERNAL_REQUEST_SECRET?: string;
};

type StoredTelegramConfig = TelegramConfig & {
  scope: BackofficeContextScope;
  createdAt: string;
  updatedAt: string;
};

export type TelegramAdminConfigResponse = {
  configured: boolean;
  config?: {
    botUsername?: string | null;
    apiBaseUrl?: string | null;
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

type TelegramWebhookRegistrationResult = {
  ok: boolean;
  message: string;
};

type TelegramAdminApiSetWebhookInput = {
  botToken: string;
  apiBaseUrl?: string | null;
  webhookUrl: string;
  secretToken: string;
  scope: BackofficeContextScope;
};

type TelegramWebhookInfo =
  | { ok: true; url: string; lastErrorMessage: string | null }
  | { ok: false; message: string };

type TelegramAdminApi = {
  setWebhook(input: TelegramAdminApiSetWebhookInput): Promise<TelegramWebhookRegistrationResult>;
  getWebhookInfo(
    input: Pick<TelegramAdminApiSetWebhookInput, "botToken" | "apiBaseUrl">,
  ): Promise<TelegramWebhookInfo>;
};

const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";

function readTelegramPublicOrigin(env: TelegramObjectEnv) {
  const configuredOrigin = env.DOCS_PUBLIC_BASE_URL?.trim();
  if (!configuredOrigin) {
    throw new Error("Telegram public origin is not configured.");
  }

  let origin: URL;
  try {
    origin = new URL(configuredOrigin);
  } catch (cause) {
    throw new Error("Telegram public origin must be an absolute HTTP or HTTPS URL.", { cause });
  }

  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("Telegram public origin must be an absolute HTTP or HTTPS URL.");
  }

  return origin.toString();
}

const maskSecret = (value: string) => {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "••••";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
};

const setAdminConfigInputSchema = telegramConfigureInputSchema;

const telegramApiResponseSchema = z.object({
  ok: z.boolean().optional(),
  description: z.string().optional(),
});

const telegramGetFileResponseSchema = telegramApiResponseSchema.extend({
  result: z.unknown().optional(),
});

const telegramWebhookInfoResponseSchema = telegramApiResponseSchema.extend({
  result: z.object({ url: z.string(), last_error_message: z.string().optional() }).optional(),
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
      botTokenPreview: maskSecret(config.botToken),
      webhookSecretTokenPreview: maskSecret(config.webhookSecretToken),
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    },
  };
}

const resolveWebhookUrl = (origin: string, scope: BackofficeContextScope) => {
  const trimmed = origin.replace(/\/+$/, "");
  return `${trimmed}/api/telegram/${backofficeScopePathSegment(scope)}/telegram/webhook`;
};

const assertTelegramObjectScope = (
  expected: BackofficeContextScope,
  actual: BackofficeContextScope,
) => {
  if (!backofficeContextScopesEqual(expected, actual)) {
    throw new Error("Backoffice object method scope does not match object address scope.");
  }
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

const createFetchTelegramAdminApi = (): TelegramAdminApi => ({
  async setWebhook({ botToken, apiBaseUrl, webhookUrl, secretToken, scope }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 8000);
    let response: Response;

    try {
      response = await fetch(
        `${normalizeTelegramApiBaseUrl(apiBaseUrl)}/bot${botToken}/setWebhook`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: secretToken,
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (error && typeof error === "object" && "name" in error) {
        const name = String((error as { name?: string }).name);
        if (name === "AbortError") {
          console.warn("Telegram webhook request timed out", {
            scope,
            webhookUrl,
          });
          return { ok: false, message: "Telegram API request timed out" };
        }
      }
      console.error("Telegram webhook request failed", {
        scope,
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
        scope,
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
  },
  async getWebhookInfo({ botToken, apiBaseUrl }) {
    const response = await fetch(
      `${normalizeTelegramApiBaseUrl(apiBaseUrl)}/bot${botToken}/getWebhookInfo`,
      { method: "GET", signal: AbortSignal.timeout(8000) },
    );
    const payloadResult = telegramWebhookInfoResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    const payload = payloadResult.success ? payloadResult.data : null;
    if (!response.ok || !payload?.ok || !payload.result) {
      return {
        ok: false,
        message:
          payload?.description ?? `Telegram API rejected getWebhookInfo (${response.status}).`,
      };
    }
    return {
      ok: true,
      url: payload.result.url,
      lastErrorMessage: payload.result.last_error_message ?? null,
    };
  },
});

export class TelegramObject extends RpcTarget implements TelegramCommands {
  readonly #env: TelegramObjectEnv;
  readonly #state: BackofficeObjectState;
  readonly #runtime: BackofficeRuntimeServices;
  readonly #kernel: BackofficeKernel;
  readonly #nowEpochMs: () => number;
  readonly #api?: TelegramApi;
  readonly #adminApi?: TelegramAdminApi;
  #scope: BackofficeContextScope | null = null;
  readonly #host: BackofficeFragmentDurableObject<
    StoredTelegramConfig,
    TelegramFragmentConfig,
    TelegramFragment,
    IntegrationSlotOutboxItem
  >;

  constructor({
    state,
    env,
    runtime,
    implementation,
    nowEpochMs,
    api,
    adminApi,
  }: {
    state: BackofficeObjectState;
    env?: TelegramObjectEnv;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    nowEpochMs: () => number;
    api?: TelegramApi;
    adminApi?: TelegramAdminApi;
  }) {
    super();
    this.#env = env ?? {};
    this.#state = state;
    this.#runtime = runtime;
    this.#kernel = new BackofficeKernel(runtime);
    this.#nowEpochMs = nowEpochMs;
    this.#api = api;
    this.#scope = backofficeContextScopeFromDurableObjectId(state.id, "TELEGRAM");
    this.#adminApi = adminApi;
    this.#host = implementation.createConfiguredFragmentHost({
      name: "Telegram",
      toSource: (stored) => ({
        botToken: stored.botToken,
        webhookSecretToken: stored.webhookSecretToken,
        botUsername: stored.botUsername,
        apiBaseUrl: stored.apiBaseUrl,
      }),
      createRuntime: (config) =>
        createTelegramServer(config, implementation.fragmentDatabase, this.#kernel, {
          api: this.#api,
          hooks: {
            onMessageReceived: async (payload, context) => {
              const runtime = this.#host.getConfigured();
              if (!runtime) {
                console.warn(
                  "Ignoring Telegram message because automations routing is unavailable",
                  {
                    scope: null,
                    updateId: payload.updateId,
                    messageId: payload.messageId,
                  },
                );
                return;
              }

              const { scope } = runtime.stored;
              await this.#runtime.objects.automations
                .for(scope)
                .commands.triggerIngestEvent(
                  buildTelegramAutomationEvent(scope, payload, context.hookId.toString()),
                  { propagationContext: context.capturePropagationContext() },
                );
            },
          },
        }),
      outbox: {
        dispatch: (item: IntegrationSlotOutboxItem) =>
          recordIntegrationSlotChange(
            (scope) => this.#runtime.objects.automations.for(scope).commands,
            item,
            telegramConnectionIdentity,
          ),
      },
    });

    void state.blockConcurrencyWhile(async () => {
      const stored = await this.#host.loadStored();
      if (stored) {
        const storedScope = (stored as Partial<StoredTelegramConfig>).scope;
        if (!storedScope) {
          throw new Error("Stored Telegram config is missing a scope.");
        }
        if (!this.#scope) {
          this.#scope = storedScope;
        } else {
          assertTelegramObjectScope(this.#scope, storedScope);
        }
      }
      await this.#host.initializeFromStored(stored);
    });
  }

  #requireScope(): BackofficeContextScope {
    if (!this.#scope) {
      throw new Error("Telegram object has not been initialized with scope metadata.");
    }

    return this.#scope;
  }

  #assertStoredScope(stored: StoredTelegramConfig | null) {
    this.#host.assertSameScope(stored, this.#requireScope());
  }

  async getAutomationFile(input: { fileId: string }): Promise<TelegramAutomationFileMetadata> {
    this.#assertStoredScope(this.#host.getConfigured()?.stored ?? null);
    const { source: config } = this.#host.requireConfigured();
    const { fileId } = automationFileInputSchema.parse(input);

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 8000);

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

  protected async downloadAutomationFile(input: { fileId: string }): Promise<Response> {
    const { source: config } = this.#host.requireConfigured();
    const metadata = await this.getAutomationFile(input);
    if (!metadata.filePath) {
      throw new Error("Telegram file metadata did not include a file path.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 15000);

    try {
      const response = await fetch(resolveTelegramFileDownloadUrl(config, metadata.filePath), {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Telegram file download failed with status ${response.status}.`);
      }

      return createTelegramAutomationFileResponse(response, metadata);
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
    this.#assertStoredScope(config);
    return buildConfigResponse(config);
  }

  async resetAdminConfig(): Promise<TelegramAdminConfigResponse> {
    await this.#state.blockConcurrencyWhile(async () => {
      const stored = await this.#host.loadStored();
      this.#assertStoredScope(stored);
      await this.#host.clearConfig(
        stored && {
          id: `telegram:${backofficeScopePathSegment(stored.scope)}:${stored.updatedAt}`,
          type: "connection.disconnected",
          createdAt: new Date().toISOString(),
          scope: stored.scope,
        },
      );
    });
    return { configured: false };
  }

  async setAdminConfig(payload: unknown): Promise<TelegramAdminConfigResponse> {
    const config = setAdminConfigInputSchema.parse(payload);
    const scope = this.#requireScope();
    const webhookUrl = resolveWebhookUrl(readTelegramPublicOrigin(this.#env), scope);

    const existing = await this.#host.loadStored();
    this.#host.assertSameScope(existing, scope);

    const now = new Date().toISOString();
    const createdAt = existing?.createdAt ?? now;
    const stored: StoredTelegramConfig = {
      ...config,
      scope,
      createdAt,
      updatedAt: now,
    };

    try {
      await this.#state.blockConcurrencyWhile(async () => {
        await this.#host.storeAndInitialize(stored);
        const configuredAt = new Date().toISOString();
        await this.#host.dispatch({
          id: crypto.randomUUID(),
          type: "connection.ready",
          createdAt: configuredAt,
          scope,
        });
      });
    } catch {
      throw new Error("Failed to migrate Telegram schema.");
    }

    const webhookResult = await (this.#adminApi ?? createFetchTelegramAdminApi()).setWebhook({
      botToken: stored.botToken,
      apiBaseUrl: stored.apiBaseUrl,
      webhookUrl,
      secretToken: stored.webhookSecretToken,
      scope,
    });

    return {
      configured: true,
      config: {
        botUsername: stored.botUsername ?? null,
        apiBaseUrl: stored.apiBaseUrl ?? null,
        botTokenPreview: maskSecret(stored.botToken),
        webhookSecretTokenPreview: maskSecret(stored.webhookSecretToken),
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      },
      webhook: webhookResult,
    };
  }

  async checkWebhook(): Promise<WebhookRegistrationCheck> {
    const { stored } = this.#host.requireConfigured();
    this.#assertStoredScope(stored);
    const expectedUrl = resolveWebhookUrl(readTelegramPublicOrigin(this.#env), stored.scope);
    const info = await (this.#adminApi ?? createFetchTelegramAdminApi()).getWebhookInfo({
      botToken: stored.botToken,
      apiBaseUrl: stored.apiBaseUrl,
    });
    if (!info.ok) {
      return { registered: false, message: info.message };
    }
    if (info.url !== expectedUrl) {
      return {
        registered: false,
        message: info.url
          ? "Telegram delivers this bot's updates to a different webhook URL."
          : "Telegram has no webhook registered for this bot.",
      };
    }
    return info.lastErrorMessage === null
      ? { registered: true, message: "Telegram delivers this bot's updates to this deployment." }
      : {
          registered: true,
          message: `The webhook is registered; Telegram's last delivery failed: ${info.lastErrorMessage}`,
        };
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    this.#requireScope();
    return await this.#host.getDurableHookQueue(({ runtime }) => runtime, options);
  }

  async getDurableHook(hookId: string) {
    this.#requireScope();
    return await this.#host.getDurableHook(({ runtime }) => runtime, hookId);
  }

  async wakeDurableHooks() {
    await this.#host.wake();
  }

  async fetch(request: Request): Promise<Response> {
    const scope = this.#requireScope();
    const forwardHttpRequest = createBackofficeFragmentHttpTransport({
      address: { binding: "TELEGRAM", scope: backofficeObjectScopeFromContextScope(scope) },
      env: this.#env,
      nowEpochMs: this.#nowEpochMs,
    });
    return await forwardHttpRequest(request, async (verifiedRequest, options) => {
      const automationFileId = telegramAutomationFileIdFromDownloadPath(
        new URL(verifiedRequest.url).pathname,
      );
      if (verifiedRequest.method === "GET" && automationFileId) {
        // File bytes are an object-owned endpoint, not a Telegram fragment route.
        const denied = await authorizeBackofficeFragmentRequest(
          this.#kernel,
          options.requestContext,
          BACKOFFICE_PERMISSION.integrations.execute,
          null,
        );
        return denied ?? (await this.downloadAutomationFile({ fileId: automationFileId }));
      }
      return await this.#host.fetch(verifiedRequest, options);
    });
  }
}
