import type { BackofficeOrganizationContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { telegramAttachmentSchema } from "@fragno-dev/telegram-fragment/types";
import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { AutomationExternalEntityDefinition } from "@/fragno/automation/contracts";
import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";

import type { TelegramAdminConfigResponse } from "../../../../workers/telegram-object";

const AUTOMATION_SOURCE = "telegram" as const;
const AUTOMATION_EVENT_MESSAGE_RECEIVED = "message.received" as const;

const optionalTrimmedString = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

const absoluteUrl = optionalTrimmedString.refine((value) => !value || URL.canParse(value), {
  message: "Must be a valid absolute URL.",
});

export const telegramConfigureInputSchema = z.object({
  botToken: z.string().trim().min(1, "Bot token is required."),
  webhookSecretToken: z.string().trim().min(1, "Webhook secret token is required."),
  botUsername: optionalTrimmedString,
  apiBaseUrl: absoluteUrl,
});

const telegramAutomationExternalEntities = {
  user: {
    scope: "external",
    source: AUTOMATION_SOURCE,
    type: "user",
    label: "Telegram user",
    description:
      "Person who sent a message in any chat with the bot; links to one Backoffice user.",
  },
  chat: {
    scope: "external",
    source: AUTOMATION_SOURCE,
    type: "chat",
    label: "Telegram chat",
    description: "Channel or group that sent a message as itself, naming no person.",
  },
} as const satisfies Record<string, AutomationExternalEntityDefinition<typeof AUTOMATION_SOURCE>>;

const telegramMessageReceivedPayloadSchema = z.object({
  messageId: z.string().min(1).describe("Telegram message ID; messages.edit takes it."),
  chatId: z
    .string()
    .min(1)
    .describe(
      "Telegram chat ID; equals fromUserId in a private chat. backoffice#telegram actions take it.",
    ),
  fromUserId: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "Sender's Telegram user ID, also the user initiator's id; null when Telegram omits the sender.",
    ),
  text: z
    .string()
    .nullable()
    .describe("Message text; null for messages without text, such as attachments."),
  attachments: z
    .array(telegramAttachmentSchema)
    .optional()
    .describe(
      "Voice notes, photos, and files as metadata; files.get and files.download take each fileId.",
    ),
});

const telegramMessageReceivedActorSchema = z.object({
  scope: z.literal("external"),
  source: z.literal(AUTOMATION_SOURCE),
  type: z
    .enum(["user", "chat"])
    .describe("user when a person sent the message; chat when a chat sent it as itself."),
  id: z.string().min(1),
  role: z.literal("initiator"),
});

const connectionStatusIdentity = {
  id: "telegram",
  label: "Telegram",
  kind: "connection",
} as const;
const getTelegramDo = (
  objects: BackofficeObjectRegistry,
  organization: BackofficeOrganizationContextScope,
) => objects.telegram.for(organization);

const toTelegramStatus = (response: TelegramAdminConfigResponse): ConnectionStatus => {
  if (!response.configured) {
    return {
      ...connectionStatusIdentity,
      configured: false,
      missing: ["botToken"],
    };
  }

  return {
    ...connectionStatusIdentity,
    configured: true,
    config: response.config,
    ...(response.webhook ? { verification: response.webhook } : {}),
  };
};

export const telegramCapability: BackofficeCapability = {
  id: connectionStatusIdentity.id,
  label: connectionStatusIdentity.label,
  objectBinding: null,
  contributions: {
    connection: {
      getStatus: async ({ objects, organization }) =>
        toTelegramStatus(await getTelegramDo(objects, organization).commands.getAdminConfig()),
    },
    eventSources: [
      {
        source: AUTOMATION_SOURCE,
        label: "Telegram",
        description: "Messages received by the connected Telegram bot.",
      },
    ],
    actionProviders: ["integrations"],
    hookScopes: [
      {
        id: "telegram",
        label: "Telegram",
        getRepository: ({ objects, organization }) =>
          createDurableHookRepositoryFromCommands(getTelegramDo(objects, organization).commands),
      },
    ],
    skillPaths: [],
    externalEntities: [
      telegramAutomationExternalEntities.user,
      telegramAutomationExternalEntities.chat,
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
    ],
  },
};
