import { telegramAttachmentSchema } from "@fragno-dev/telegram-fragment/types";
import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { AutomationExternalEntityDefinition } from "@/fragno/automation/contracts";
import type {
  BackofficeConfigurableConnectionCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createTelegramCapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/telegram-files";

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

export const telegramAutomationExternalEntities = {
  chat: {
    scope: "external",
    source: AUTOMATION_SOURCE,
    type: "chat",
    label: "Telegram chat",
    description: "Telegram chat or conversation that can send and receive bot messages.",
  },
} as const satisfies Record<string, AutomationExternalEntityDefinition<typeof AUTOMATION_SOURCE>>;

const telegramMessageReceivedPayloadSchema = z.object({
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  fromUserId: z.string().min(1).nullable(),
  text: z.string().nullable(),
  attachments: z.array(telegramAttachmentSchema).optional(),
});

const telegramMessageReceivedActorSchema = z.object({
  scope: z.literal("external"),
  source: z.literal(AUTOMATION_SOURCE),
  type: z.literal("chat"),
  id: z.string().min(1),
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
const getTelegramDo = (objects: BackofficeObjectRegistry, orgId: string) =>
  objects.telegram.forOrg(orgId);

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
  get files() {
    return createTelegramCapabilityFiles();
  },
  externalEntities: [telegramAutomationExternalEntities.chat],
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
    getStatus: async ({ objects, orgId }) =>
      toTelegramStatus(await getTelegramDo(objects, orgId).getAdminConfig()),
    verify: async ({ objects, orgId }) =>
      toTelegramStatus(await getTelegramDo(objects, orgId).getAdminConfig()),
    reset: async ({ objects, orgId }) =>
      toTelegramStatus(await getTelegramDo(objects, orgId).resetAdminConfig()),
    configure: async ({ objects, orgId, origin, payload }) =>
      toTelegramStatus(
        await getTelegramDo(objects, orgId).setAdminConfig(
          { ...telegramConfigureInputSchema.parse(payload), orgId },
          origin,
        ),
      ),
  },
  hooks: [
    {
      id: "telegram",
      label: "Telegram",
      getRepository: ({ objects, orgId }) =>
        getTelegramDo(objects, orgId).getDurableHookRepository(),
    },
  ],
  automationEvents: [
    {
      source: AUTOMATION_SOURCE,
      eventType: AUTOMATION_EVENT_MESSAGE_RECEIVED,
      label: "Telegram message received",
      payloadSchema: telegramMessageReceivedPayloadSchema,
      actorSchema: telegramMessageReceivedActorSchema,
      example: {
        messageId: "42",
        chatId: "123456789",
        fromUserId: "123456789",
        text: "hello",
        attachments: [
          {
            kind: "voice",
            fileId: "voice-file-1",
            fileUniqueId: "voice-unique-1",
            duration: 3,
            mimeType: "audio/ogg",
          },
        ],
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
