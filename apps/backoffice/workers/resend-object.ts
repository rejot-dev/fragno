import {
  backofficeJurisdictionSchema,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Resend as ResendClient } from "resend";
import { z } from "zod";

import { isUniqueConstraintError } from "@fragno-dev/db";
import type { ResendFragmentConfig, ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import { createBackofficeFragmentHttpTransport } from "@/backoffice-runtime/fragment-http-transport";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  type ResendCommands,
  type WebhookRegistrationCheck,
  requireBackofficeContextScopeFromDurableObjectId,
  backofficeObjectScopeFromContextScope,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { resendConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/resend";
import { type DurableHookQueueOptions } from "@/fragno/durable-hooks";
import { createResendServer, type ResendConfig, type ResendFragment } from "@/fragno/resend";
import {
  recordIntegrationSlotChange,
  type IntegrationSlotOutboxItem,
} from "@/fragno/runtime-tools/families/integrations/integration-events";
import { resendConnectionIdentity } from "@/fragno/runtime-tools/families/integrations/resend-integration";

import type {
  BackofficeFragmentDurableObject,
  BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

export type ResendConfigScope = Extract<BackofficeContextScope, { kind: "system" | "org" }>;

type StoredResendConfig = Omit<ResendConfig, "webhookSecret" | "defaultFrom"> & {
  scope: ResendConfigScope;
  defaultFrom: string;
  webhookBaseUrl?: string;
  webhookId?: string;
  webhookSecret?: string;
  createdAt: string;
  updatedAt: string;
};

export type ConfigResponse = {
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
const DEVELOPMENT_SUBJECT_PREFIX = "[DEVELOPMENT]";

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

const prefixDevelopmentEmailSubject = (
  input: ResendSendEmailInput,
  runtimeMode: string,
): ResendSendEmailInput => {
  if (runtimeMode !== "development" || input.subject.startsWith(DEVELOPMENT_SUBJECT_PREFIX)) {
    return input;
  }

  return {
    ...input,
    subject: `${DEVELOPMENT_SUBJECT_PREFIX} ${input.subject}`,
  };
};

/** The configured sender's address under another name, e.g. a first-party app's. */
function fromAs(senderName: string, defaultFrom: string): string {
  const address = /<([^<>]+)>\s*$/u.exec(defaultFrom)?.[1] ?? defaultFrom;
  // Quoted, the name cannot break out of the header; quotes and line breaks in it are dropped.
  return `"${senderName.replace(/["\\\r\n]/gu, "")}" <${address.trim()}>`;
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

const resendConfigScopeSchema: z.ZodType<ResendConfigScope> = z.union([
  z.object({ kind: z.literal("system") }),
  z.object({
    kind: z.literal("org"),
    orgId: z.string().trim().min(1, "Stored Resend config is missing an organization id."),
    // A config stored before jurisdictions existed names none, which is what it meant.
    jurisdiction: backofficeJurisdictionSchema.nullable().default(null),
  }),
]);

const storedResendConfigSchema: z.ZodType<StoredResendConfig> = z.object({
  scope: resendConfigScopeSchema,
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

const resolveWebhookUrl = (origin: string, scope: ResendConfigScope, baseUrl?: string) => {
  const resolvedOrigin = baseUrl ?? origin;
  const trimmed = resolvedOrigin.replace(/\/+$/, "");
  const scopeSegment = backofficeScopePathSegment(scope);
  return `${trimmed}/api/resend/${scopeSegment}/webhook`;
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

export class ResendObject implements ResendCommands {
  readonly #httpTransport: ReturnType<typeof createBackofficeFragmentHttpTransport>;
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #host: BackofficeFragmentDurableObject<
    StoredResendConfig,
    ResendFragmentConfig,
    ResendFragment,
    IntegrationSlotOutboxItem
  >;
  readonly #createClient: (apiKey: string) => ResendClient;
  readonly #runtimeMode: string;

  constructor({
    state,
    env,
    nowEpochMs,
    runtime,
    implementation,
    createClient = (apiKey) => new ResendClient(apiKey),
    runtimeMode = import.meta.env.MODE,
  }: {
    state: BackofficeObjectState;
    env: Pick<BackofficeRuntimeEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;
    nowEpochMs: () => number;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    createClient?: (apiKey: string) => ResendClient;
    runtimeMode?: string;
  }) {
    this.#httpTransport = createBackofficeFragmentHttpTransport({
      address: {
        binding: "RESEND",
        scope: backofficeObjectScopeFromContextScope(
          requireBackofficeContextScopeFromDurableObjectId(state.id, "RESEND"),
        ),
      },
      env,
      nowEpochMs,
    });
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#createClient = createClient;
    this.#runtimeMode = runtimeMode;
    this.#host = implementation.createConfiguredFragmentHost({
      name: "Resend",
      configKey: CONFIG_KEY,
      parseStored: (raw) => storedResendConfigSchema.parse(raw),
      isConfigured: (stored): stored is StoredResendConfig =>
        Boolean(stored?.scope && stored.apiKey && stored.webhookSecret && stored.defaultFrom),
      toSource: (stored) => ({
        apiKey: stored.apiKey,
        webhookSecret: stored.webhookSecret ?? "",
        defaultFrom: stored.defaultFrom,
        defaultReplyTo: stored.defaultReplyTo,
        defaultTags: stored.defaultTags,
        defaultHeaders: stored.defaultHeaders,
      }),
      fingerprint: (config) => JSON.stringify(config),
      createRuntime: (config) =>
        createResendServer(config, implementation.fragmentDatabase, new BackofficeKernel(runtime)),
      outbox: {
        dispatch: (item: IntegrationSlotOutboxItem) =>
          recordIntegrationSlotChange(
            (scope) => this.#runtimeServices.objects.automations.for(scope).commands,
            item,
            resendConnectionIdentity,
          ),
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
      const stored = await this.#host.loadStored();
      await this.#host.clearConfig(
        stored && {
          id: `resend:${backofficeScopePathSegment(stored.scope)}:${stored.updatedAt}`,
          type: "connection.disconnected",
          createdAt: new Date().toISOString(),
          scope: stored.scope,
        },
      );
    });
    return { configured: false };
  }

  async setAdminConfig(
    payload: unknown,
    scopeInput: ResendConfigScope,
    origin: string,
  ): Promise<ConfigResponse> {
    const scope = resendConfigScopeSchema.parse(scopeInput);

    return await this.#state.blockConcurrencyWhile(async () => {
      const existing = await this.#host.loadStored();
      this.#host.assertSameScope(existing, scope);

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
        scope,
        apiKey: parsed.data.apiKey,
        defaultFrom: parsed.data.defaultFrom,
        defaultReplyTo,
        webhookBaseUrl,
        webhookId: existing?.webhookId,
        webhookSecret: existing?.webhookSecret,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      const client = this.#createClient(stored.apiKey);
      const webhookUrl = resolveWebhookUrl(origin, scope, stored.webhookBaseUrl);
      const scopeLabel = backofficeScopePathSegment(scope);

      let webhookResult: WebhookResult;

      if (stored.webhookId && stored.webhookSecret) {
        webhookResult = await updateWebhook(client, stored.webhookId, webhookUrl, scopeLabel);
        if (!webhookResult.ok) {
          const fallback = await createWebhook(client, webhookUrl, scopeLabel);
          if (fallback.ok) {
            webhookResult = fallback;
          }
        }
      } else {
        webhookResult = await createWebhook(client, webhookUrl, scopeLabel);
      }

      if (webhookResult.ok) {
        stored.webhookId = webhookResult.webhookId ?? stored.webhookId;
        stored.webhookSecret = webhookResult.webhookSecret ?? stored.webhookSecret;

        try {
          await this.#host.storeAndInitialize(stored);
          const configuredAt = new Date().toISOString();
          await this.#host.dispatch({
            id: crypto.randomUUID(),
            type: "connection.ready",
            createdAt: configuredAt,
            scope,
          });
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

  /** `senderName` sends from the configured address under that name instead of its own. */
  async queueEmail(
    input: ResendSendEmailInput,
    options: { idempotencyKey: string; senderName: string | null },
  ): Promise<void> {
    const configured = this.#host.getConfigured();
    if (this.#runtimeServices.config.localEmailLog) {
      // Prints secrets such as reset links, so the setting exists only in local .dev.vars.
      console.info(
        `Email to ${[input.to].flat().join(", ")}: ${input.subject}\n\n${input.text ?? input.html}`,
      );
      if (!configured) {
        return;
      }
    }
    if (!configured) {
      throw new Error("Resend is not configured for email delivery.");
    }
    const { runtime: fragment, stored } = configured;
    const email =
      options.senderName === null
        ? input
        : { ...input, from: fromAs(options.senderName, stored.defaultFrom) };

    try {
      await fragment.callServices(() =>
        fragment.services.queueEmail(prefixDevelopmentEmailSubject(email, this.#runtimeMode), {
          idempotencyKey: options.idempotencyKey,
        }),
      );
      await this.#state.storage.setAlarm(Date.now());
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        return;
      }
      throw cause;
    }
  }

  async checkWebhook(): Promise<WebhookRegistrationCheck> {
    const { stored } = this.#host.requireConfigured("Resend is not configured.");
    const { webhookId, webhookBaseUrl } = stored;
    // Configurations saved before the webhook base URL was required may lack either value.
    if (!webhookId || !webhookBaseUrl) {
      return {
        registered: false,
        message:
          "No webhook is recorded for this configuration; reconfigure Resend to register one.",
      };
    }
    try {
      const { data, error } = await this.#createClient(stored.apiKey).webhooks.get(webhookId);
      if (error) {
        return { registered: false, message: error.message };
      }
      const expectedUrl = resolveWebhookUrl(webhookBaseUrl, stored.scope);
      if (data.endpoint !== expectedUrl) {
        return {
          registered: false,
          message: "Resend delivers this webhook to a different URL.",
        };
      }
      return data.status === "enabled"
        ? { registered: true, message: "Resend delivers email events to this deployment." }
        : { registered: false, message: "Resend has disabled this webhook." };
    } catch (error) {
      return {
        registered: false,
        message: error instanceof Error ? error.message : "Resend webhook request failed.",
      };
    }
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await this.#host.getDurableHookQueue(({ runtime }) => runtime, options);
  }

  async getDurableHook(hookId: string) {
    return await this.#host.getDurableHook(({ runtime }) => runtime, hookId);
  }

  async wakeDurableHooks() {
    await this.#host.wake();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#httpTransport(request, (verifiedRequest, options) =>
      this.#host.fetch(verifiedRequest, options),
    );
  }
}
