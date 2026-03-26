import { normalizeTelegramMessage } from "./telegram-utils";
import type { TelegramApi, TelegramApiResult, TelegramFragmentConfig } from "./types";

const normalizeBaseUrl = (url: string) => url.replace(/\/+$/, "");

const filterUndefined = (payload: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));

type TelegramApiEnvelope = {
  ok?: unknown;
  result?: unknown;
  error_code?: unknown;
  errorCode?: unknown;
  description?: unknown;
};

type SendMessagePayload = {
  chatId?: unknown;
  chat_id?: unknown;
  text?: unknown;
  parseMode?: unknown;
  parse_mode?: unknown;
  disableWebPagePreview?: unknown;
  disable_web_page_preview?: unknown;
  replyToMessageId?: unknown;
  reply_to_message_id?: unknown;
};

type EditMessageTextPayload = SendMessagePayload & {
  messageId?: unknown;
  message_id?: unknown;
};

type SendChatActionPayload = {
  chatId?: unknown;
  chat_id?: unknown;
  action?: unknown;
};

const normalizeSendMessagePayload = (payload: Record<string, unknown>) => {
  const message = payload as SendMessagePayload;
  return filterUndefined({
    chat_id: message.chat_id ?? message.chatId,
    text: message.text,
    parse_mode: message.parse_mode ?? message.parseMode,
    disable_web_page_preview: message.disable_web_page_preview ?? message.disableWebPagePreview,
    reply_to_message_id: message.reply_to_message_id ?? message.replyToMessageId,
  });
};

const normalizeEditMessageTextPayload = (payload: Record<string, unknown>) => {
  const message = payload as EditMessageTextPayload;
  return filterUndefined({
    chat_id: message.chat_id ?? message.chatId,
    message_id: message.message_id ?? message.messageId,
    text: message.text,
    parse_mode: message.parse_mode ?? message.parseMode,
    disable_web_page_preview: message.disable_web_page_preview ?? message.disableWebPagePreview,
  });
};

const normalizeSendChatActionPayload = (payload: Record<string, unknown>) => {
  const action = payload as SendChatActionPayload;
  return filterUndefined({
    chat_id: action.chat_id ?? action.chatId,
    action: action.action,
  });
};

const normalizeTelegramApiResult = <T>(
  data: unknown,
  normalizeResult: (value: unknown) => T,
): TelegramApiResult<T> | null => {
  if (!data || typeof data !== "object") {
    return null;
  }

  const envelope = data as TelegramApiEnvelope;
  if (envelope.ok === true) {
    return {
      ok: true,
      result: normalizeResult(envelope.result),
    };
  }

  if (envelope.ok === false) {
    return {
      ok: false,
      errorCode:
        typeof envelope.errorCode === "number"
          ? envelope.errorCode
          : typeof envelope.error_code === "number"
            ? envelope.error_code
            : undefined,
      description: typeof envelope.description === "string" ? envelope.description : undefined,
    };
  }

  return null;
};

export function createTelegramApi(
  config: Pick<TelegramFragmentConfig, "botToken" | "apiBaseUrl">,
): TelegramApi {
  const baseUrl = normalizeBaseUrl(config.apiBaseUrl ?? "https://api.telegram.org");
  const token = config.botToken;

  const callRaw = async (method: string, payload: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(`${baseUrl}/bot${token}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    try {
      return await response.json();
    } catch {
      return null;
    }
  };

  const call = async <T>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<TelegramApiResult<T>> => {
    try {
      const data = await callRaw(method, payload);
      const result = normalizeTelegramApiResult(data, (value) => value as T);
      if (result) {
        return result;
      }

      return {
        ok: false,
        description: "Telegram API returned an unexpected response",
      };
    } catch (error) {
      return {
        ok: false,
        description: error instanceof Error ? error.message : "Telegram API request failed",
      };
    }
  };

  const callWithNormalization = async <T>(
    method: string,
    payload: Record<string, unknown>,
    normalizeResult: (value: unknown) => T,
  ): Promise<TelegramApiResult<T>> => {
    try {
      const data = await callRaw(method, payload);
      const result = normalizeTelegramApiResult(data, normalizeResult);
      if (result) {
        return result;
      }

      return {
        ok: false,
        description: `Telegram API returned an invalid ${method} result`,
      };
    } catch (error) {
      return {
        ok: false,
        description: error instanceof Error ? error.message : "Telegram API request failed",
      };
    }
  };

  return {
    call,
    sendMessage: (payload) =>
      callWithNormalization(
        "sendMessage",
        normalizeSendMessagePayload(payload),
        normalizeTelegramMessage,
      ),
    editMessageText: (payload) =>
      callWithNormalization(
        "editMessageText",
        normalizeEditMessageTextPayload(payload),
        normalizeTelegramMessage,
      ),
    sendChatAction: (payload) =>
      callWithNormalization("sendChatAction", normalizeSendChatActionPayload(payload), (value) => {
        if (typeof value !== "boolean") {
          throw new Error("Invalid Telegram boolean result");
        }
        return value;
      }),
  };
}
