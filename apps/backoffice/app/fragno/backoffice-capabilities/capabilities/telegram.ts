import { z } from "zod";

import type {
  BackofficeConfigurableConnectionCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import type { TelegramAdminConfigResponse } from "../../../../workers/telegram.do";

const AUTOMATION_SOURCE = "telegram" as const;
const AUTOMATION_EVENT_MESSAGE_RECEIVED = "message.received" as const;
const AUTOMATION_EVENT_CAPABILITY_CONFIGURED = "capability.configured" as const;

const optionalTrimmedString = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

const absoluteUrl = optionalTrimmedString.refine((value) => !value || URL.canParse(value), {
  message: "Must be a valid absolute URL.",
});

const requiredHttpUrl = z
  .string()
  .trim()
  .min(1, "Webhook base URL is required.")
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Webhook base URL must include http:// or https://." },
  );

export const telegramConfigureInputSchema = z.object({
  botToken: z.string().trim().min(1, "Bot token is required."),
  webhookSecretToken: z.string().trim().min(1, "Webhook secret token is required."),
  botUsername: optionalTrimmedString,
  apiBaseUrl: absoluteUrl,
  webhookBaseUrl: requiredHttpUrl,
});

const telegramMessageReceivedPayloadSchema = z.object({
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  fromUserId: z.string().min(1).nullable(),
  text: z.string().nullable(),
  attachments: z.array(z.unknown()).optional(),
});

const telegramCapabilityConfiguredPayloadSchema = z.object({
  capabilityId: z.literal("telegram"),
  capabilityLabel: z.literal("Telegram"),
});

const telegramCapabilityConfiguredSubjectSchema = z.object({
  orgId: z.string().trim().min(1),
  capabilityId: z.literal("telegram"),
});

const capability = { id: "telegram", label: "Telegram", kind: "connection" } as const;
const getTelegramDo = (env: CloudflareEnv, orgId: string) =>
  env.TELEGRAM.get(env.TELEGRAM.idFromName(orgId));

const toTelegramStatus = (response: TelegramAdminConfigResponse): ConnectionStatus => {
  if (!response.configured) {
    return {
      ...capability,
      configured: false,
      missing: ["botToken", "webhookSecretToken", "webhookBaseUrl"],
    };
  }

  return {
    ...capability,
    configured: true,
    config: response.config,
    ...(response.webhook ? { verification: response.webhook } : {}),
  };
};

export const telegramCapability: BackofficeConfigurableConnectionCapability = {
  ...capability,
  runtimeToolNamespaces: ["telegram"],
  connection: {
    configurable: true,
    configureInputSchema: telegramConfigureInputSchema,
    configureFields: [
      {
        name: "botToken",
        required: true,
        secret: true,
        description: "Telegram BotFather bot token.",
      },
      {
        name: "webhookSecretToken",
        required: true,
        secret: true,
        description: "Secret token Telegram sends with webhook requests.",
      },
      { name: "botUsername", description: "Optional bot username, with or without @." },
      { name: "apiBaseUrl", description: "Optional Telegram API base URL override." },
      {
        name: "webhookBaseUrl",
        required: true,
        description: "Public http(s) base URL used when registering the Telegram webhook.",
      },
    ],
    setup: {
      overview: "Connect a Telegram bot to this organisation.",
      manualSteps: [
        {
          id: "create-bot",
          title: "Create bot",
          instructions: "Create a bot with BotFather and copy the bot token.",
          expectedUserInput: ["botToken"],
        },
        {
          id: "choose-webhook-secret",
          title: "Choose webhook secret and public URL",
          instructions:
            "Choose a long random webhook secret token and provide the public Backoffice origin or tunnel URL.",
          expectedUserInput: ["webhookSecretToken", "webhookBaseUrl"],
        },
      ],
      verify: {
        tool: "connections.get --id telegram",
        description: "Check configured=true and webhook verification if present.",
      },
    },
    getStatus: async ({ env, orgId }) =>
      toTelegramStatus(await getTelegramDo(env, orgId).getAdminConfig()),
    verify: async ({ env, orgId }) =>
      toTelegramStatus(await getTelegramDo(env, orgId).getAdminConfig()),
    reset: async ({ env, orgId }) =>
      toTelegramStatus(await getTelegramDo(env, orgId).resetAdminConfig()),
    configure: async ({ env, orgId, origin, payload }) =>
      toTelegramStatus(
        await getTelegramDo(env, orgId).setAdminConfig(
          { ...telegramConfigureInputSchema.parse(payload), orgId },
          origin,
        ),
      ),
  },
  hooks: [
    {
      id: "telegram",
      label: "Telegram",
      getRepository: ({ env, orgId }) => getTelegramDo(env, orgId).getDurableHookRepository(),
    },
  ],
  automationEvents: [
    {
      source: AUTOMATION_SOURCE,
      eventType: AUTOMATION_EVENT_MESSAGE_RECEIVED,
      label: "Telegram message received",
      payloadSchema: telegramMessageReceivedPayloadSchema,
      example: {
        messageId: "42",
        chatId: "123456789",
        fromUserId: "123456789",
        text: "hello",
      },
    },
    {
      source: AUTOMATION_SOURCE,
      eventType: AUTOMATION_EVENT_CAPABILITY_CONFIGURED,
      label: "Telegram configured",
      description: "Fires after Telegram is configured for an organisation for the first time.",
      payloadSchema: telegramCapabilityConfiguredPayloadSchema,
      subjectSchema: telegramCapabilityConfiguredSubjectSchema,
      example: {
        capabilityId: "telegram",
        capabilityLabel: "Telegram",
      },
    },
  ],
};
