import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

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
    initiator: {
      scope: "external",
      source: AUTOMATION_SOURCES.telegram,
      // Only a private sender's own conversation can stand for that human identity.
      // Shared conversations must never reuse a legacy chat-to-user binding.
      type: payload.fromUserId === payload.chatId ? "chat" : "shared-chat",
      id: payload.chatId,
      role: "initiator",
    },
    principal: null,
    delegation: [],
  },
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
    let resource: { kind: "telegram-chat"; chatId: string } | null = null;
    await ifMatchesRoute("POST", "/telegram/webhook", ({ path }) => {
      // Route matching can normalize aliases; only the exact webhook URL is public.
      if (new URL(request.url).pathname === `${fragment.mountRoute}${path}`) {
        access = "public-ingress";
      }
    });
    await ifMatchesRoute("GET", "/commands", () => {
      access = BACKOFFICE_PERMISSION.telegram.read;
    });
    await ifMatchesRoute("GET", "/chats", () => {
      access = BACKOFFICE_PERMISSION.telegram.read;
    });
    await ifMatchesRoute("GET", "/chats/:chatId", () => {
      access = BACKOFFICE_PERMISSION.telegram.read;
    });
    await ifMatchesRoute("GET", "/chats/:chatId/messages", () => {
      access = BACKOFFICE_PERMISSION.telegram.read;
    });
    await ifMatchesRoute("POST", "/commands/bind", () => {
      access = BACKOFFICE_PERMISSION.connections.manage;
    });
    await ifMatchesRoute("POST", "/chats/:chatId/send", ({ pathParams }) => {
      access = BACKOFFICE_PERMISSION.telegram.send;
      resource = { kind: "telegram-chat", chatId: pathParams.chatId };
    });
    await ifMatchesRoute("POST", "/chats/:chatId/actions", ({ pathParams }) => {
      access = BACKOFFICE_PERMISSION.telegram.send;
      resource = { kind: "telegram-chat", chatId: pathParams.chatId };
    });
    await ifMatchesRoute("POST", "/chats/:chatId/messages/:messageId/edit", ({ pathParams }) => {
      access = BACKOFFICE_PERMISSION.telegram.send;
      resource = { kind: "telegram-chat", chatId: pathParams.chatId };
    });
    return await authorizeBackofficeFragmentRequest(kernel, requestContext, access, resource);
  });
}

export type TelegramFragment = ReturnType<typeof createTelegramServer>;
