import { createRouteCaller } from "@fragno-dev/core/api";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectHandle, TelegramObject } from "@/backoffice-runtime/object-registry";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import { telegramAutomationFileDownloadPath } from "@/backoffice-runtime/telegram-file-response";
import type {
  TelegramRuntime,
  TelegramAutomationFileMetadata,
} from "@/fragno/runtime-tools/families/telegram";
import type { TelegramFragment } from "@/fragno/telegram";

import {
  createOrganizationNotConfiguredMessage,
  isSuccessStatus,
  throwOnRouteRuntimeError,
  throwOnHttpResponseError,
} from "../runtime-errors";

export type { TelegramRuntime, TelegramAutomationFileMetadata };

export type RegisteredTelegramCommandContext = {
  runtime: TelegramRuntime;
};

const TELEGRAM_NOT_CONFIGURED = createOrganizationNotConfiguredMessage("Telegram");

type CreateRouteBackedTelegramRuntimeOptions = {
  baseUrl: string;
  headers?: HeadersInit;
  fetch: (request: Request) => Promise<Response>;
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
        throw new Error(`Unsupported Telegram chat action: ${String(action)}`);
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

/** Binds Telegram commands to execution provenance; the receiving object enforces its policy. */
export function createTelegramRuntime({
  object,
  execution,
  kernel,
}: {
  object: BackofficeObjectHandle<TelegramObject>;
  execution: BackofficeExecutionContext;
  kernel: BackofficeKernel;
}): TelegramRuntime {
  const context = { execution, propagationContext: null };
  const routeBacked = createRouteBackedTelegramRuntime({
    baseUrl: "https://telegram.do",
    fetch: async (outboundRequest) => object.http.fetchAuthorized(outboundRequest, context),
  });

  return {
    getFile: async (input) =>
      await kernel.invoke({
        execution,
        operation: BACKOFFICE_PERMISSION.telegram.read,
        execute: () => object.commands.getAutomationFile(input),
      }),
    downloadFile: async ({ fileId }) => {
      const response = await object.http.fetchAuthorized(
        new Request(`https://telegram.do${telegramAutomationFileDownloadPath(fileId)}`),
        context,
      );
      if (!response.ok) {
        await throwOnHttpResponseError(response, {
          runtimeLabel: "Telegram fragment",
          label: "telegram.file.download",
        });
      }
      return response;
    },
    sendMessage: routeBacked.sendMessage,
    sendChatAction: routeBacked.sendChatAction,
    editMessage: routeBacked.editMessage,
  };
}

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
