import {
  createTelegram,
  createTelegramFragment,
  defineCommand,
  type TelegramFragmentConfig,
} from "@fragno-dev/telegram-fragment";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";

export type TelegramConfig = Pick<
  TelegramFragmentConfig,
  "botToken" | "webhookSecretToken" | "botUsername" | "apiBaseUrl"
>;

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

export function createTelegramServer(config: TelegramConfig, state: DurableObjectState) {
  const telegramConfig = createTelegram(config)
    .command(
      defineCommand("start", {
        description: "Welcome message",
        handler: async ({ api, chat, fromUser }) => {
          const greeting = fromUser?.firstName ? `Welcome, ${fromUser.firstName}!` : "Welcome!";
          const text = `${greeting}\nThis bot is connected to your Fragno back office. You can now send messages and see them in the chat overview.`;
          const result = await api.sendMessage({
            chat_id: chat.id,
            text,
          });

          if (!result.ok) {
            console.warn("Failed to send /start welcome message", result.description);
          }
        },
      }),
    )
    .build();

  return createTelegramFragment(telegramConfig, {
    databaseAdapter: createAdapter(state),
    mountRoute: "/api/telegram",
  });
}

export type TelegramFragment = ReturnType<typeof createTelegramServer>;
