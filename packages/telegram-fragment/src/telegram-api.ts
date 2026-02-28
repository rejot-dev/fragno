import type { TelegramApi, TelegramApiResult, TelegramFragmentConfig } from "./types";

const normalizeBaseUrl = (url: string) => url.replace(/\/+$/, "");

export function createTelegramApi(
  config: Pick<TelegramFragmentConfig, "botToken" | "apiBaseUrl">,
): TelegramApi {
  const baseUrl = normalizeBaseUrl(config.apiBaseUrl ?? "https://api.telegram.org");
  const token = config.botToken;

  const call = async <T>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<TelegramApiResult<T>> => {
    try {
      const response = await fetch(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      let data: TelegramApiResult<T> | null = null;
      try {
        data = (await response.json()) as TelegramApiResult<T>;
      } catch {
        data = null;
      }

      if (data && typeof data === "object" && "ok" in data) {
        return data;
      }

      return {
        ok: false,
        description: response.ok
          ? "Telegram API returned an unexpected response"
          : `Telegram API error (${response.status})`,
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
    sendMessage: (payload) => call("sendMessage", payload),
    editMessageText: (payload) => call("editMessageText", payload),
    sendChatAction: (payload) => call("sendChatAction", payload),
  };
}
