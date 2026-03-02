import type {
  TelegramCommandBindings,
  TelegramCommandScope,
  TelegramMessage,
  TelegramUpdate,
  TelegramUpdateType,
} from "./types";
import { telegramCommandBindingsSchema } from "./types";

export const DEFAULT_COMMAND_SCOPES: TelegramCommandScope[] = [
  "private",
  "group",
  "supergroup",
  "channel",
];

export type ParsedTelegramUpdate = {
  updateId: number;
  type: TelegramUpdateType;
  message: TelegramMessage;
};

export function parseTelegramUpdate(update: TelegramUpdate): ParsedTelegramUpdate | null {
  if (update.message) {
    return { updateId: update.update_id, type: "message", message: update.message };
  }
  if (update.edited_message) {
    return { updateId: update.update_id, type: "edited_message", message: update.edited_message };
  }
  if (update.channel_post) {
    return { updateId: update.update_id, type: "channel_post", message: update.channel_post };
  }
  return null;
}

export function buildMessageId(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

export function buildChatMemberId(chatId: string, userId: string): string {
  return `${chatId}:${userId}`;
}

export function parseCommand(
  message: TelegramMessage,
  botUsername?: string,
): { name: string; args: string; raw: string } | null {
  if (!message.text) {
    return null;
  }

  const text = message.text;
  let commandToken: string | null = null;

  const entity = message.entities?.find(
    (entry) => entry.type === "bot_command" && entry.offset === 0,
  );
  if (entity) {
    commandToken = text.slice(0, entity.length);
  }

  if (!commandToken && text.startsWith("/")) {
    commandToken = text.split(/\s+/)[0] ?? null;
  }

  if (!commandToken) {
    return null;
  }

  const withoutSlash = commandToken.slice(1);
  if (!withoutSlash) {
    return null;
  }

  const [name, atBot] = withoutSlash.split("@");
  if (atBot && botUsername && atBot.toLowerCase() !== botUsername.toLowerCase()) {
    return null;
  }

  const args = text.slice(commandToken.length).trim();

  return {
    name,
    args,
    raw: commandToken,
  };
}

export function parseCommandBindings(value: unknown): TelegramCommandBindings {
  if (!value) {
    return {};
  }
  const result = telegramCommandBindingsSchema.safeParse(value);
  if (!result.success) {
    return {};
  }
  return result.data;
}
