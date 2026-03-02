import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";
import type { TelegramChatSummary, TelegramMessageSummary } from "@fragno-dev/telegram-fragment";
import type { TelegramFragment } from "@/fragno/telegram";
import { getTelegramDurableObject } from "@/cloudflare/cloudflare-utils";
import type { TelegramConfigState } from "./organisation-telegram-shared";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const createTelegramRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const telegramDo = getTelegramDurableObject(context, orgId);
  return createRouteCaller<TelegramFragment>({
    baseUrl: request.url,
    mountRoute: "/api/telegram",
    baseHeaders: request.headers,
    fetch: telegramDo.fetch.bind(telegramDo),
  });
};

type TelegramConfigResult = {
  configState: TelegramConfigState | null;
  configError: string | null;
};

type TelegramChatsResult = {
  chats: TelegramChatSummary[];
  chatsError: string | null;
};

type TelegramChatMessagesResult = {
  messages: TelegramMessageSummary[];
  cursor?: string;
  hasNextPage: boolean;
  messagesError: string | null;
};

type TelegramQueuedResponse = {
  ok: boolean;
  queued: boolean;
};

type TelegramSendMessageResult = {
  result: TelegramQueuedResponse | null;
  error: string | null;
};

export async function fetchTelegramConfig(
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<TelegramConfigResult> {
  try {
    const telegramDo = getTelegramDurableObject(context, orgId);
    const configState = await telegramDo.getAdminConfig();
    return { configState, configError: null };
  } catch (error) {
    return {
      configState: null,
      configError: error instanceof Error ? error.message : "Failed to load configuration.",
    };
  }
}

export async function fetchTelegramChats(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<TelegramChatsResult> {
  try {
    const callRoute = createTelegramRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/chats");

    if (response.type === "json") {
      return { chats: response.data, chatsError: null };
    }

    if (response.type === "error") {
      return {
        chats: [],
        chatsError: response.error.message,
      };
    }

    return {
      chats: [],
      chatsError: `Failed to fetch chats (${response.status}).`,
    };
  } catch (error) {
    return {
      chats: [],
      chatsError: error instanceof Error ? error.message : "Failed to load chats.",
    };
  }
}

export async function fetchTelegramChatMessages(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  chatId: string,
  options: { order?: "asc" | "desc"; pageSize?: number; cursor?: string } = {},
): Promise<TelegramChatMessagesResult> {
  try {
    const callRoute = createTelegramRouteCaller(request, context, orgId);
    const requestedPageSize =
      typeof options.pageSize === "number" && Number.isFinite(options.pageSize)
        ? options.pageSize
        : DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
    const query: Record<string, string> = {
      order: options.order ?? "asc",
      pageSize: String(pageSize),
    };
    if (options.cursor) {
      query.cursor = options.cursor;
    }

    const response = await callRoute("GET", "/chats/:chatId/messages", {
      pathParams: { chatId },
      query,
    });

    if (response.type === "json") {
      return {
        messages: response.data.messages ?? [],
        cursor: response.data.cursor,
        hasNextPage: response.data.hasNextPage ?? false,
        messagesError: null,
      };
    }

    if (response.type === "error") {
      return {
        messages: [],
        cursor: undefined,
        hasNextPage: false,
        messagesError: response.error.message,
      };
    }

    return {
      messages: [],
      cursor: undefined,
      hasNextPage: false,
      messagesError: `Failed to fetch messages (${response.status}).`,
    };
  } catch (error) {
    return {
      messages: [],
      cursor: undefined,
      hasNextPage: false,
      messagesError: error instanceof Error ? error.message : "Failed to load messages.",
    };
  }
}

export async function sendTelegramChatMessage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  chatId: string,
  payload: {
    text: string;
    parseMode?: "MarkdownV2" | "Markdown" | "HTML";
    disableWebPagePreview?: boolean;
    replyToMessageId?: number;
  },
): Promise<TelegramSendMessageResult> {
  try {
    const callRoute = createTelegramRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/chats/:chatId/send", {
      pathParams: { chatId },
      body: payload,
    });

    if (response.type === "json") {
      return { result: response.data, error: null };
    }

    if (response.type === "error") {
      return {
        result: null,
        error: response.error.message,
      };
    }

    return {
      result: null,
      error: `Failed to send message (${response.status}).`,
    };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : "Failed to send message.",
    };
  }
}
