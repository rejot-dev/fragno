import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { z } from "zod";

import {
  createTelegram,
  createTelegramFragment,
  type TelegramFragmentConfig,
  type TelegramMessageHookPayload,
} from "@fragno-dev/telegram-fragment";

import type {
  AutomationKnownEvent,
  AutomationSourceAdapter,
  AutomationSourceReplyInput,
} from "./automation/contracts";
import { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES } from "./automation/contracts";

export type TelegramConfig = Pick<
  TelegramFragmentConfig,
  "botToken" | "webhookSecretToken" | "botUsername" | "apiBaseUrl"
>;

export type TelegramServerOptions = {
  hooks?: TelegramFragmentConfig["hooks"];
};

export const telegramMessageReceivedPayloadSchema = z.object({
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  fromUserId: z.string().min(1).nullable(),
  text: z.string().nullable(),
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
  },
  actor: {
    type: "external",
    externalId: payload.chatId,
  },
});

export const createTelegramSourceAdapter = (
  options: {
    reply?: (input: AutomationSourceReplyInput) => Promise<void>;
  } = {},
): AutomationSourceAdapter<typeof AUTOMATION_SOURCES.telegram> => ({
  source: AUTOMATION_SOURCES.telegram,
  eventSchemas: {
    [AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived]: telegramMessageReceivedPayloadSchema,
  },
  toBashEnv: (event) => {
    const payload = telegramMessageReceivedPayloadSchema.parse(event.payload);

    return {
      AUTOMATION_TELEGRAM_MESSAGE_ID: payload.messageId,
      AUTOMATION_TELEGRAM_CHAT_ID: payload.chatId,
      AUTOMATION_TELEGRAM_FROM_USER_ID: payload.fromUserId ?? undefined,
      AUTOMATION_TELEGRAM_TEXT: payload.text ?? undefined,
    };
  },
  ...(options.reply ? { reply: options.reply } : {}),
});

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

export function createTelegramServer(
  config: TelegramConfig,
  state: DurableObjectState,
  options: TelegramServerOptions = {},
): ReturnType<typeof createTelegramFragment> {
  const telegramConfig = createTelegram({
    ...config,
    hooks: options.hooks,
  }).build();

  return createTelegramFragment(telegramConfig, {
    databaseAdapter: createAdapter(state),
    mountRoute: "/api/telegram",
  });
}

export type TelegramFragment = ReturnType<typeof createTelegramServer>;
