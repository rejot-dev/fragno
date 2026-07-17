import { DurableObject } from "cloudflare:workers";
import { Resend as ResendClient } from "resend";
import { z } from "zod";

import { isUniqueConstraintError } from "@fragno-dev/db";
import type { ResendFragmentConfig, ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { ResendObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { AUTOMATION_SYSTEM_ACTOR } from "@/fragno/automation/contracts";
import { resendConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/resend";
import { type DurableHookQueueOptions } from "@/fragno/durable-hooks";
import { createResendServer, type ResendConfig, type ResendFragment } from "@/fragno/resend";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
  type BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";

type ResendConfigScope = Extract<BackofficeContextScope, { kind: "system" | "org" }>;

type StoredResendConfig = Omit<ResendConfig, "webhookSecret"> & {
  scope: ResendConfigScope;
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
    orgId: z.string().trim().min(1, "Stored Resend config is missing an organisation id."),
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
  const scopeSegment = backofficeContextScopeSinglePathSegment(scope);
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

export class InMemoryResendObject implements ResendObject {
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #host: BackofficeFragmentDurableObject<
    StoredResendConfig,
    ResendFragmentConfig,
    ResendFragment
  >;
  readonly #createClient: (apiKey: string) => ResendClient;
  readonly #runtimeMode: string;

  constructor({
    state,
    env,
    runtime,
    createClient = (apiKey) => new ResendClient(apiKey),
    runtimeMode = import.meta.env.MODE,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
    createClient?: (apiKey: string) => ResendClient;
    runtimeMode?: string;
  }) {
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#createClient = createClient;
    this.#runtimeMode = runtimeMode;
    this.#host = createBackofficeFragmentDurableObject({
      name: "Resend",
      state,
      env,
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
        createResendServer(config, {
          adapters: this.#runtimeServices.adapters,
        }),
      outbox: {
        dispatch: async (item, { stored }) => {
          if (item.type !== "capability.configured") {
            return;
          }

          const { scope } = stored;
          if (scope.kind === "system") {
            return;
          }

          await this.#runtimeServices.objects.automations.for(scope).ingestEvent({
            id: item.id,
            scope,
            source: "resend",
            eventType: "capability.configured",
            occurredAt: item.createdAt,
            payload: {
              capabilityId: "resend",
              capabilityLabel: "Resend",
            },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: scope.orgId,
              capabilityId: "resend",
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
      const scopeLabel = backofficeContextScopeSinglePathSegment(scope);

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
            type: "capability.configured",
            createdAt: configuredAt,
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

  async queueEmail(
    input: ResendSendEmailInput,
    options: { idempotencyKey: string },
  ): Promise<void> {
    const { runtime: fragment } = this.#host.requireConfigured(
      "Resend is not configured for email delivery.",
    );

    try {
      await fragment.callServices(() =>
        fragment.services.queueEmail(prefixDevelopmentEmailSubject(input, this.#runtimeMode), {
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

  getDurableHookRepository() {
    return this.#host.getDurableHookRepository<DurableHookQueueOptions>(({ runtime }) => runtime);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}

export class Resend extends DurableObject<CloudflareEnv> implements ResendObject {
  readonly #object: InMemoryResendObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryResendObject({
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

  async setAdminConfig(
    payload: unknown,
    scope: ResendConfigScope,
    origin: string,
  ): Promise<ConfigResponse> {
    return await this.#object.setAdminConfig(payload, scope, origin);
  }

  async queueEmail(
    input: ResendSendEmailInput,
    options: { idempotencyKey: string },
  ): Promise<void> {
    await this.#object.queueEmail(input, options);
  }

  getDurableHookRepository() {
    return this.#object.getDurableHookRepository();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
