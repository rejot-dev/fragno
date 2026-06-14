import { createRouteCaller } from "@fragno-dev/core/api";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type {
  TelegramRuntime,
  TelegramAutomationFileMetadata,
  TelegramEditMessageArgs,
  TelegramFileDownloadArgs,
  TelegramFileGetArgs,
  TelegramQueuedMessageOutput,
  TelegramSendActionArgs,
  TelegramSendMessageArgs,
  TelegramActionOutput,
} from "@/fragno/runtime-tools/families/telegram";
import type { TelegramFragment } from "@/fragno/telegram";

import {
  createOrganisationNotConfiguredMessage,
  isSuccessStatus,
  throwOnRouteRuntimeError,
} from "../runtime-errors";

export type {
  TelegramRuntime,
  TelegramActionOutput,
  TelegramAutomationFileMetadata,
  TelegramEditMessageArgs,
  TelegramFileDownloadArgs,
  TelegramFileGetArgs,
  TelegramQueuedMessageOutput,
  TelegramSendActionArgs,
  TelegramSendMessageArgs,
};

export type RegisteredTelegramCommandContext = {
  runtime: TelegramRuntime;
};

const TELEGRAM_NOT_CONFIGURED = createOrganisationNotConfiguredMessage("Telegram");

type CreateRouteBackedTelegramRuntimeOptions = {
  baseUrl: string;
  headers?: HeadersInit;
  fetch(request: Request): Promise<Response>;
};

export type TelegramRouteBackedCommands = Pick<
  TelegramRuntime,
  "sendMessage" | "sendChatAction" | "editMessage"
>;

const createTelegramRouteCaller = (
  options: Pick<CreateRouteBackedTelegramRuntimeOptions, "baseUrl" | "headers" | "fetch">,
) => {
  return createRouteCaller<TelegramFragment>({
    baseUrl: options.baseUrl,
    mountRoute: "/api/telegram",
    ...(options.headers ? { baseHeaders: options.headers } : {}),
    fetch: options.fetch,
  });
};

export const createRouteBackedTelegramRuntime = (
  options: CreateRouteBackedTelegramRuntimeOptions,
): TelegramRouteBackedCommands => {
  const baseUrl = options.baseUrl.trim();
  if (!baseUrl) {
    throw new Error("Telegram runtime requires a base URL");
  }

  const callRoute = createTelegramRouteCaller({
    baseUrl,
    headers: options.headers,
    fetch: options.fetch,
  });

  return {
    sendMessage: async ({ chatId, text, parseMode, disableWebPagePreview, replyToMessageId }) => {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        throw new Error("telegram.chat.send requires a chat id");
      }
      const normalizedText = text.trim();
      if (!normalizedText) {
        throw new Error("telegram.chat.send requires non-empty text");
      }

      const response = await callRoute("POST", "/chats/:chatId/send", {
        pathParams: { chatId: normalizedChatId },
        body: {
          text: normalizedText,
          ...(parseMode ? { parseMode } : {}),
          ...(disableWebPagePreview ? { disableWebPagePreview: true } : {}),
          ...(typeof replyToMessageId === "number" ? { replyToMessageId } : {}),
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Telegram fragment",
        label: "telegram.chat.send",
        notConfiguredMessage: TELEGRAM_NOT_CONFIGURED,
      });
    },
    sendChatAction: async ({ chatId, action }) => {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        throw new Error("telegram.chat.actions requires a chat id");
      }
      if (action !== "typing") {
        throw new Error(`Unsupported Telegram chat action: ${action}`);
      }

      const response = await callRoute("POST", "/chats/:chatId/actions", {
        pathParams: { chatId: normalizedChatId },
        body: { action: "typing" },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Telegram fragment",
        label: "telegram.chat.actions",
        notConfiguredMessage: TELEGRAM_NOT_CONFIGURED,
      });
    },
    editMessage: async ({ chatId, messageId, text, parseMode, disableWebPagePreview }) => {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        throw new Error("telegram.message.edit requires a chat id");
      }
      const normalizedMessageId = messageId.trim();
      if (!normalizedMessageId) {
        throw new Error("telegram.message.edit requires a message id");
      }
      const normalizedText = text.trim();
      if (!normalizedText) {
        throw new Error("telegram.message.edit requires non-empty text");
      }

      const response = await callRoute("POST", "/chats/:chatId/messages/:messageId/edit", {
        pathParams: { chatId: normalizedChatId, messageId: normalizedMessageId },
        body: {
          text: normalizedText,
          ...(parseMode ? { parseMode } : {}),
          ...(disableWebPagePreview ? { disableWebPagePreview: true } : {}),
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Telegram fragment",
        label: "telegram.message.edit",
        notConfiguredMessage: TELEGRAM_NOT_CONFIGURED,
      });
    },
  };
};

export const createTelegramRuntime = ({
  objects,
  orgId,
}: {
  objects: BackofficeObjectRegistry;
  orgId: string;
}): TelegramRuntime => {
  const telegramDo = objects.telegram.forOrg(orgId);
  const routeBacked = createRouteBackedTelegramRuntime({
    baseUrl: "https://telegram.do",
    fetch: async (outboundRequest) => telegramDo.fetch(outboundRequest),
  });

  return {
    getFile: async (input) => telegramDo.getAutomationFile(input),
    downloadFile: async (input) => telegramDo.downloadAutomationFile(input),
    ...routeBacked,
  };
};

export const createUnavailableTelegramRuntime = (
  message = TELEGRAM_NOT_CONFIGURED,
): TelegramRuntime => ({
  getFile: async () => {
    throw new Error(message);
  },
  downloadFile: async () => {
    throw new Error(message);
  },
  sendMessage: async () => {
    throw new Error(message);
  },
  sendChatAction: async () => {
    throw new Error(message);
  },
  editMessage: async () => {
    throw new Error(message);
  },
});
