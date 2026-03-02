import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { telegramFragmentDefinition } from "./definition";
import { telegramRoutesFactory } from "./routes";
import type { TelegramFragmentConfig } from "./types";

const routes = [telegramRoutesFactory] as const;

export function createTelegramFragment(
  config: TelegramFragmentConfig,
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  return instantiate(telegramFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();
}

export function createTelegramFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(telegramFragmentDefinition, fragnoConfig, routes);

  return {
    useCommands: builder.createHook("/commands"),
    useBindCommand: builder.createMutator("POST", "/commands/bind"),
    useChats: builder.createHook("/chats"),
    useChat: builder.createHook("/chats/:chatId"),
    useChatMessages: builder.createHook("/chats/:chatId/messages"),
    useChatAction: builder.createMutator("POST", "/chats/:chatId/actions"),
    useSendMessage: builder.createMutator("POST", "/chats/:chatId/send"),
    useEditMessage: builder.createMutator("POST", "/chats/:chatId/messages/:messageId/edit"),
  };
}

export { telegramFragmentDefinition } from "./definition";
export { telegramRoutesFactory } from "./routes";
export { telegramSchema } from "./schema";
export { createTelegram, defineCommand } from "./types";
export type {
  TelegramApi,
  TelegramApiResult,
  TelegramChatMemberHookPayload,
  TelegramChatMemberSummary,
  TelegramChatSummary,
  TelegramChatType,
  TelegramCommandBinding,
  TelegramCommandBindings,
  TelegramConfigBuilder,
  TelegramCommandContext,
  TelegramCommandDefinition,
  TelegramCommandRegistry,
  TelegramCommandScope,
  TelegramFragmentConfig,
  TelegramHooks,
  TelegramMessage,
  TelegramMessageHookPayload,
  TelegramMessageSummary,
  TelegramUpdateType,
  TelegramUpdate,
  TelegramUser,
  TelegramUserSummary,
} from "./types";
export type { FragnoRouteConfig } from "@fragno-dev/core";
