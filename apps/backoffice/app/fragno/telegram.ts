import { z } from "zod";

import {
  createTelegram,
  createTelegramFragment,
  telegramAttachmentSchema,
  type TelegramApi,
  type TelegramFragmentConfig,
  type TelegramMessageHookPayload,
} from "@fragno-dev/telegram-fragment";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import type { AutomationKnownEvent } from "./automation/contracts";
import { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES } from "./automation/contracts";

export type TelegramConfig = Pick<
  TelegramFragmentConfig,
  "botToken" | "webhookSecretToken" | "botUsername" | "apiBaseUrl"
>;

export type TelegramServerOptions = {
  hooks?: TelegramFragmentConfig["hooks"];
  api?: TelegramApi;
};

export const telegramMessageReceivedPayloadSchema = z.object({
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  fromUserId: z.string().min(1).nullable(),
  text: z.string().nullable(),
  attachments: z.array(telegramAttachmentSchema).optional(),
});

type SerializableTelegramMessageHookPayload = Omit<
  TelegramMessageHookPayload,
  "sentAt" | "editedAt"
> & {
  sentAt: Date | string;
  editedAt: Date | string | null;
};

const toIsoString = (value: Date | string, fieldName: string) => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid Telegram hook date for ${fieldName}`);
  }

  return parsed.toISOString();
};

export const buildTelegramAutomationEvent = (
  orgId: string,
  payload: SerializableTelegramMessageHookPayload,
): AutomationKnownEvent<typeof AUTOMATION_SOURCES.telegram> => ({
  id: `telegram:${orgId}:${payload.updateId}:${payload.messageId}`,
  orgId,
  source: AUTOMATION_SOURCES.telegram,
  eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
  occurredAt: toIsoString(payload.sentAt, "sentAt"),
  payload: {
    messageId: payload.messageId,
    chatId: payload.chatId,
    fromUserId: payload.fromUserId,
    text: payload.text,
    ...(payload.attachments.length > 0 ? { attachments: payload.attachments } : {}),
  },
  actor: {
    scope: "external",
    source: AUTOMATION_SOURCES.telegram,
    type: "chat",
    id: payload.chatId,
    role: "initiator",
  },
  actors: [
    {
      scope: "external",
      source: AUTOMATION_SOURCES.telegram,
      type: "chat",
      id: payload.chatId,
      role: "initiator",
    },
  ],
});

export function createTelegramServer(
  config: TelegramConfig,
  runtime: BackofficeFragmentRuntimeOptions,
  options: TelegramServerOptions = {},
): ReturnType<typeof createTelegramFragment> {
  const telegramConfig = createTelegram({
    ...config,
    hooks: options.hooks,
    api: options.api,
  }).build();

  return createTelegramFragment(telegramConfig, {
    databaseAdapter: runtime.adapters.createAdapter({
      kind: "telegram",
    }),
    mountRoute: "/api/telegram",
  });
}

export type TelegramFragment = ReturnType<typeof createTelegramServer>;
