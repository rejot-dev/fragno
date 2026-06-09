import { DurableObject } from "cloudflare:workers";
import { Resend as ResendClient } from "resend";
import { z } from "zod";

import type { ResendFragmentConfig } from "@fragno-dev/resend-fragment";

import { resendConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/resend";
import { type DurableHookQueueOptions } from "@/fragno/durable-hooks";
import { createResendServer, type ResendConfig, type ResendFragment } from "@/fragno/resend";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
} from "./lib/backoffice-fragment-durable-object";

type StoredResendConfig = Omit<ResendConfig, "webhookSecret"> & {
  orgId: string;
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
  "email.received",
] as const;

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

const optionalTrimmedStringSchema = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

const stringListSchema = z
  .union([
    z.string(),
    z
      .array(z.string())
      .transform((entries) =>
        entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
      ),
  ])
  .transform(normalizeReplyTo)
  .optional();

const storedResendConfigSchema: z.ZodType<StoredResendConfig> = z.object({
  orgId: z.string().trim().min(1, "Stored Resend config is missing an organisation id."),
  apiKey: z.string().trim().min(1, "Stored Resend config is missing an API key."),
  defaultFrom: z.string().trim().min(1, "Stored Resend config is missing defaultFrom."),
  defaultReplyTo: stringListSchema,
  defaultTags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  webhookBaseUrl: optionalTrimmedStringSchema,
  webhookId: optionalTrimmedStringSchema,
  webhookSecret: optionalTrimmedStringSchema,
  createdAt: z.string().trim().min(1, "Stored Resend config is missing createdAt."),
  updatedAt: z.string().trim().min(1, "Stored Resend config is missing updatedAt."),
});

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
        webhookBaseUrl: string;
      };
    }
  | { ok: false; message: string }
> => {
  const parsedPayload = resendConfigureInputSchema.safeParse(payload);
  if (!parsedPayload.success) {
    return {
      ok: false,
      message: parsedPayload.error.issues[0]?.message ?? "Invalid Resend config.",
    };
  }

  const payloadRecord = parsedPayload.data as Record<string, unknown>;
  const apiKeyRaw = typeof payloadRecord.apiKey === "string" ? payloadRecord.apiKey.trim() : "";
  const defaultFrom =
    typeof payloadRecord.defaultFrom === "string" ? payloadRecord.defaultFrom.trim() : "";
  const hasDefaultReplyTo = Object.prototype.hasOwnProperty.call(payloadRecord, "defaultReplyTo");
  const defaultReplyToRaw =
    typeof payloadRecord.defaultReplyTo === "string" || Array.isArray(payloadRecord.defaultReplyTo)
      ? payloadRecord.defaultReplyTo
      : undefined;
  const webhookBaseUrl = parsedPayload.data.webhookBaseUrl;

  const apiKey = apiKeyRaw || existing?.apiKey || "";
  const resolvedDefaultFrom = defaultFrom || existing?.defaultFrom || "";

  if (!apiKey) {
    return { ok: false, message: "Resend API key is required." };
  }

  if (!resolvedDefaultFrom) {
    return { ok: false, message: "Default from address is required." };
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
  return `${trimmed}/api/resend/${orgId}/webhook`;
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
  #state: DurableObjectState;
  #host: BackofficeFragmentDurableObject<StoredResendConfig, ResendFragmentConfig, ResendFragment>;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#state = state;
    this.#host = createBackofficeFragmentDurableObject({
      name: "Resend",
      state,
      env,
      configKey: CONFIG_KEY,
      parseStored: (raw) => storedResendConfigSchema.parse(raw),
      isConfigured: (stored): stored is StoredResendConfig =>
        Boolean(stored?.orgId && stored.apiKey && stored.webhookSecret && stored.defaultFrom),
      toSource: (stored) => ({
        apiKey: stored.apiKey,
        webhookSecret: stored.webhookSecret ?? "",
        defaultFrom: stored.defaultFrom,
        defaultReplyTo: stored.defaultReplyTo,
        defaultTags: stored.defaultTags,
        defaultHeaders: stored.defaultHeaders,
      }),
      fingerprint: (config) => JSON.stringify(config),
      createRuntime: (config) => createResendServer(config, state),
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

  async setAdminConfig(payload: unknown, orgId: string, origin: string): Promise<ConfigResponse> {
    const normalizedOrgId = orgId.trim();
    if (!normalizedOrgId) {
      throw new Error("Missing organisation id.");
    }

    return await this.#state.blockConcurrencyWhile(async () => {
      const existing = await this.#host.loadStored();
      this.#host.assertSameOrg(existing, normalizedOrgId);

      const parsed = await parseConfigInput(payload, existing);
      if (!parsed.ok) {
        throw new Error(parsed.message);
      }

      const now = new Date().toISOString();
      const defaultReplyTo =
        parsed.data.defaultReplyTo === undefined
          ? existing?.defaultReplyTo
          : (parsed.data.defaultReplyTo ?? undefined);
      const webhookBaseUrl = parsed.data.webhookBaseUrl;
      const stored: StoredResendConfig = {
        orgId: normalizedOrgId,
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
      const webhookUrl = resolveWebhookUrl(origin, normalizedOrgId, stored.webhookBaseUrl);

      let webhookResult: WebhookResult;

      if (stored.webhookId && stored.webhookSecret) {
        webhookResult = await updateWebhook(client, stored.webhookId, webhookUrl, normalizedOrgId);
        if (!webhookResult.ok) {
          const fallback = await createWebhook(client, webhookUrl, normalizedOrgId);
          if (fallback.ok) {
            webhookResult = fallback;
          }
        }
      } else {
        webhookResult = await createWebhook(client, webhookUrl, normalizedOrgId);
      }

      if (webhookResult.ok) {
        stored.webhookId = webhookResult.webhookId ?? stored.webhookId;
        stored.webhookSecret = webhookResult.webhookSecret ?? stored.webhookSecret;

        try {
          await this.#host.storeAndInitialize(stored);
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
    });
  }

  getDurableHookRepository() {
    return this.#host.getDurableHookRepository<DurableHookQueueOptions>(({ runtime }) => runtime);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
