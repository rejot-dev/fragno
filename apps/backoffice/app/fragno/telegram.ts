import {
  createTelegram,
  createTelegramFragment,
  type TelegramApi,
  type TelegramFragmentConfig,
  type TelegramMessageHookPayload,
} from "@fragno-dev/telegram-fragment";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
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

const telegramEventScopeId = (scope: BackofficeContextScope) => {
  switch (scope.kind) {
    case "system":
      return "system";
    case "org":
      return `org:${scope.orgId}`;
    case "project":
      return `project:${scope.orgId}:${scope.projectId}`;
    case "user":
      return `user:${scope.userId}`;
  }

  throw new Error("Unsupported Backoffice context scope kind.");
};

export const buildTelegramAutomationEvent = (
  scope: BackofficeContextScope,
  payload: SerializableTelegramMessageHookPayload,
  eventId = `telegram:${telegramEventScopeId(scope)}:${payload.updateId}:${payload.messageId}`,
): AutomationKnownEvent<typeof AUTOMATION_SOURCES.telegram> => ({
  id: eventId,
  scope,
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
