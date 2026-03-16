import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";

import {
  createTelegram,
  createTelegramFragment,
  defineCommand,
  type TelegramFragmentConfig,
} from "@fragno-dev/telegram-fragment";

import { storeTelegramUserLink } from "./telegram-links";

export type TelegramConfig = Pick<
  TelegramFragmentConfig,
  "botToken" | "webhookSecretToken" | "botUsername" | "apiBaseUrl"
>;

export type TelegramServerOptions = {
  env?: Pick<CloudflareEnv, "OTP">;
  orgId?: string;
};

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

const sendStartMessage = async (
  api: {
    sendMessage: (
      payload: Record<string, unknown>,
    ) => Promise<{ ok: boolean; description?: string }>;
  },
  chatId: string,
  text: string,
) => {
  const result = await api.sendMessage({
    chat_id: chatId,
    text,
  });

  if (!result.ok) {
    console.warn("Failed to send /start message", result.description);
  }
};

export function createTelegramServer(
  config: TelegramConfig,
  state: DurableObjectState,
  options: TelegramServerOptions = {},
): ReturnType<typeof createTelegramFragment> {
  const { env, orgId } = options;

  const telegramConfig = createTelegram(config)
    .command(
      defineCommand("start", {
        description: "Welcome message and Telegram account linking",
        handler: async ({ api, chat, fromUser, command }) => {
          const startToken = command.args.trim();

          if (!startToken) {
            const greeting = fromUser?.firstName ? `Welcome, ${fromUser.firstName}!` : "Welcome!";
            await sendStartMessage(
              api,
              chat.id,
              `${greeting}\nThis bot is connected to your Fragno back office. Generate a Telegram link in the back office to connect this chat to your user account.`,
            );
            return;
          }

          if (!env || !orgId) {
            await sendStartMessage(
              api,
              chat.id,
              "Telegram linking is not available for this organisation yet. Please try again from the back office.",
            );
            return;
          }

          if (!fromUser || chat.type !== "private") {
            await sendStartMessage(
              api,
              chat.id,
              "Open the bot in a direct chat and try the link again to connect your account.",
            );
            return;
          }

          const otpDo = env.OTP.get(env.OTP.idFromName(orgId));
          const resolution = await otpDo.consumeTelegramLinkOtp({ startToken });

          if (!resolution.ok) {
            const text =
              resolution.error === "OTP_EXPIRED"
                ? "That Telegram link has expired. Generate a fresh link from the back office and try again."
                : "That Telegram link is invalid or has already been used. Generate a new link from the back office and try again.";

            await sendStartMessage(api, chat.id, text);
            return;
          }

          const now = new Date().toISOString();
          await storeTelegramUserLink(state.storage, {
            orgId,
            authUserId: resolution.userId,
            telegramUserId: fromUser.id,
            chatId: chat.id,
            linkedAt: now,
            updatedAt: now,
            telegramUsername: fromUser.username,
            telegramFirstName: fromUser.firstName,
            telegramLastName: fromUser.lastName,
            chatTitle: chat.title,
          });

          await sendStartMessage(
            api,
            chat.id,
            "Your Telegram account is now linked to your back office user. You can return to the back office and continue from there.",
          );
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
