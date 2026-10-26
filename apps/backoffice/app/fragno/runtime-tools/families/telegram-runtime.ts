import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { createRouteCaller } from "@fragno-dev/core/api";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type {
  BackofficeObjectHandle,
  TelegramCommands,
} from "@/backoffice-runtime/object-registry";
import {
  telegramAutomationFileDownloadPath,
  type TelegramAutomationFileMetadata,
} from "@/backoffice-runtime/telegram-file-response";
import type { TelegramFragment } from "@/fragno/telegram";

import {
  createOrganizationNotConfiguredMessage,
  isSuccessStatus,
  throwOnRouteRuntimeError,
  throwOnHttpResponseError,
} from "../runtime-errors";

type TelegramParseMode = "MarkdownV2" | "Markdown" | "HTML";

const TELEGRAM_NOT_CONFIGURED = createOrganizationNotConfiguredMessage("Telegram");

/**
 * Binds Telegram object operations to execution provenance. Callers validate input; the receiving
 * object enforces integrations.execute.
 */
export function createTelegramRuntime({
  object,
  execution,
  kernel,
}: {
  object: BackofficeObjectHandle<TelegramCommands>;
  execution: BackofficeExecutionContext;
  kernel: BackofficeKernel;
}) {
  const context = { execution, propagationContext: null };
  const callRoute = createRouteCaller<TelegramFragment>({
    baseUrl: "https://telegram.do",
    mountRoute: "/api/telegram",
    fetch: async (request) => object.http.fetchAuthorized(request, context),
  });
  const routeError = (label: string) => ({
    runtimeLabel: "Telegram fragment",
    label,
    notConfiguredMessage: TELEGRAM_NOT_CONFIGURED,
  });

  return {
    async getFile(input: { fileId: string }): Promise<TelegramAutomationFileMetadata> {
      return await kernel.invoke({
        execution,
        operation: BACKOFFICE_PERMISSION.integrations.execute,
        execute: () => object.commands.getAutomationFile(input),
      });
    },
    async downloadFile({ fileId }: { fileId: string }): Promise<Response> {
      const response = await object.http.fetchAuthorized(
        new Request(`https://telegram.do${telegramAutomationFileDownloadPath(fileId)}`),
        context,
      );
      if (!response.ok) {
        await throwOnHttpResponseError(response, routeError("Telegram file download"));
      }
      return response;
    },
    async sendMessage({
      chatId,
      text,
      parseMode,
      disableWebPagePreview,
      replyToMessageId,
    }: {
      chatId: string;
      text: string;
      parseMode: TelegramParseMode | null;
      disableWebPagePreview: boolean;
      replyToMessageId: number | null;
    }) {
      const response = await callRoute("POST", "/chats/:chatId/send", {
        pathParams: { chatId },
        body: {
          text,
          ...(parseMode === null ? {} : { parseMode }),
          ...(disableWebPagePreview ? { disableWebPagePreview: true } : {}),
          ...(replyToMessageId === null ? {} : { replyToMessageId }),
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, routeError("Telegram message send"));
    },
    async sendChatAction({ chatId, action }: { chatId: string; action: "typing" }) {
      const response = await callRoute("POST", "/chats/:chatId/actions", {
        pathParams: { chatId },
        body: { action },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, routeError("Telegram chat action"));
    },
    async editMessage({
      chatId,
      messageId,
      text,
      parseMode,
      disableWebPagePreview,
    }: {
      chatId: string;
      messageId: string;
      text: string;
      parseMode: TelegramParseMode | null;
      disableWebPagePreview: boolean;
    }) {
      const response = await callRoute("POST", "/chats/:chatId/messages/:messageId/edit", {
        pathParams: { chatId, messageId },
        body: {
          text,
          ...(parseMode === null ? {} : { parseMode }),
          ...(disableWebPagePreview ? { disableWebPagePreview: true } : {}),
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, routeError("Telegram message edit"));
    },
  };
}
