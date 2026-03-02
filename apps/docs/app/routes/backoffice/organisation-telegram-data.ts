import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";
import type { TelegramChatSummary, TelegramMessageSummary } from "@fragno-dev/telegram-fragment";
import type { TelegramFragment } from "@/fragno/telegram";
import { getTelegramDurableObject } from "@/cloudflare/cloudflare-utils";
import type { TelegramConfigState } from "./organisation-telegram-shared";

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

export async function fetchTelegramConfig(context: Readonly<RouterContextProvider>, orgId: string) {
  try {
    const telegramDo = getTelegramDurableObject(context, orgId);
    const configState = await telegramDo.getAdminConfig();
    return { configState, configError: null };
  } catch (error) {
    return {
      configState: null as TelegramConfigState | null,
      configError: error instanceof Error ? error.message : "Failed to load configuration.",
    };
  }
}

export async function fetchTelegramChats(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) {
  try {
    const callRoute = createTelegramRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/chats");

    if (response.type === "json") {
      return { chats: response.data as TelegramChatSummary[], chatsError: null };
    }

    if (response.type === "error") {
      return {
        chats: [] as TelegramChatSummary[],
        chatsError: response.error.message,
      };
    }

    return {
      chats: [] as TelegramChatSummary[],
      chatsError: `Failed to fetch chats (${response.status}).`,
    };
  } catch (error) {
    return {
      chats: [] as TelegramChatSummary[],
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
) {
  try {
    const callRoute = createTelegramRouteCaller(request, context, orgId);
    const query: Record<string, string> = {
      order: options.order ?? "asc",
      pageSize: String(options.pageSize ?? 50),
    };
    if (options.cursor) {
      query.cursor = options.cursor;
    }

    const response = await callRoute("GET", "/chats/:chatId/messages", {
      pathParams: { chatId },
      query,
    });

    if (response.type === "json") {
      const data = response.data as {
        messages: TelegramMessageSummary[];
        cursor?: string;
        hasNextPage: boolean;
      };
      return {
        messages: data.messages ?? [],
        cursor: data.cursor,
        hasNextPage: data.hasNextPage ?? false,
        messagesError: null,
      };
    }

    if (response.type === "error") {
      return {
        messages: [] as TelegramMessageSummary[],
        cursor: undefined as string | undefined,
        hasNextPage: false,
        messagesError: response.error.message,
      };
    }

    return {
      messages: [] as TelegramMessageSummary[],
      cursor: undefined as string | undefined,
      hasNextPage: false,
      messagesError: `Failed to fetch messages (${response.status}).`,
    };
  } catch (error) {
    return {
      messages: [] as TelegramMessageSummary[],
      cursor: undefined as string | undefined,
      hasNextPage: false,
      messagesError: error instanceof Error ? error.message : "Failed to load messages.",
    };
  }
}
