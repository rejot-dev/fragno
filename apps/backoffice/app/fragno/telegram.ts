import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  createTelegram,
  createTelegramFragment,
  type TelegramApi,
  type TelegramFragmentConfig,
  type TelegramMessageHookPayload,
} from "@fragno-dev/telegram-fragment";

import {
  authorizeBackofficeFragmentRequest,
  type BackofficeFragmentHttpAccess,
} from "@/backoffice-runtime/fragment-http-authorization";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";

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

export const buildTelegramAutomationEvent = (
  scope: BackofficeContextScope,
  payload: SerializableTelegramMessageHookPayload,
  eventId = `telegram:${backofficeScopePathSegment(scope)}:${payload.updateId}:${payload.messageId}`,
): AutomationKnownEvent<typeof AUTOMATION_SOURCES.telegram> => ({
  id: eventId,
  scopeRestriction: null,
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
  actors: {
    initiator:
      // Telegram attests the sender, who stays one person in every chat. A chat that sent the
      // message as itself, such as a channel or an anonymous group admin, names no person.
      payload.fromUserId !== null && payload.senderChatId === null
        ? {
            scope: "external",
            source: AUTOMATION_SOURCES.telegram,
            type: "user",
            id: payload.fromUserId,
            role: "initiator",
          }
        : {
            scope: "external",
            source: AUTOMATION_SOURCES.telegram,
            type: "chat",
            id: payload.senderChatId ?? payload.chatId,
            role: "initiator",
          },
    principal: null,
    delegation: [],
  },
  causation: { kind: "origin" },
});

export function createTelegramServer(
  config: TelegramConfig,
  runtime: BackofficeFragmentRuntimeOptions,
  kernel: BackofficeKernel,
  options: TelegramServerOptions = {},
): ReturnType<typeof createTelegramFragment> {
  const telegramConfig = createTelegram({
    ...config,
    hooks: options.hooks,
    api: options.api,
  }).build();

  const fragment = createTelegramFragment(telegramConfig, {
    databaseAdapter: runtime.adapters.createAdapter({
      kind: "telegram",
    }),
    mountRoute: "/api/telegram",
  });
  return fragment.withMiddleware(async function authorizeTelegramRoutes({
    ifMatchesRoute,
    request,
    requestContext,
  }) {
    let access: BackofficeFragmentHttpAccess = null;
    await ifMatchesRoute("POST", "/telegram/webhook", ({ path }) => {
      // Route matching can normalize aliases; only the exact webhook URL is public.
      if (new URL(request.url).pathname === `${fragment.mountRoute}${path}`) {
        access = "public-ingress";
      }
    });
    // Bot data is read and sent on behalf of integrations.* actions and the native pages alike.
    for (const path of [
      "/commands",
      "/chats",
      "/chats/:chatId",
      "/chats/:chatId/messages",
    ] as const) {
      await ifMatchesRoute("GET", path, () => {
        access = BACKOFFICE_PERMISSION.integrations.execute;
      });
    }
    await ifMatchesRoute("POST", "/commands/bind", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    for (const path of [
      "/chats/:chatId/send",
      "/chats/:chatId/actions",
      "/chats/:chatId/messages/:messageId/edit",
    ] as const) {
      await ifMatchesRoute("POST", path, () => {
        access = BACKOFFICE_PERMISSION.integrations.execute;
      });
    }
    return await authorizeBackofficeFragmentRequest(kernel, requestContext, access, null);
  });
}

export type TelegramFragment = ReturnType<typeof createTelegramServer>;
