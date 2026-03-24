# Telegram Fragment (@fragno-dev/telegram-fragment)

## Summary

Telegram bot runtime with durable webhook intake, typed command registry, persisted
chats/members/messages, and client hooks for reading chats and sending replies.

## Use when

- You need a Telegram bot that is part of your product, not a separate side project.
- You want commands, chat history, and member state stored in your database.
- You need webhook retries and downstream hooks to be safe and replayable.

## Config

The fragment config defines bot credentials, commands, and lifecycle hooks.

What you provide:

- `botToken`: Telegram bot token.
- `webhookSecretToken`: secret used by Telegram webhook requests.
- `botUsername` (optional): bot username for command metadata.
- `apiBaseUrl` (optional): override Telegram API base URL.
- `hooks` (optional): lifecycle hooks such as `onMessageReceived`, `onCommandMatched`, and
  `onChatMemberUpdated`.
- `commands` (optional): command registry, usually assembled with `createTelegram()` and
  `defineCommand()`.

What the fragment needs via options:

- `databaseAdapter`: required for chats, members, messages, and command bindings.
- `mountRoute` (optional): choose where the fragment is mounted in your app.

## What you get

- A webhook route for incoming Telegram updates.
- Typed command registration and per-chat command binding.
- Stored chat, member, and message records in your database.
- Client hooks for commands, chats, messages, and sending/editing messages.

## Docs (curl)

Published docs pages:

- `curl -s "https://fragno.dev/api/search?query=telegram%20fragment"`
- `curl -L "https://fragno.dev/docs/telegram/quickstart" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/telegram/routes" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/telegram/hooks" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/telegram/webhook" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/telegram/commands" -H "accept: text/markdown"`

Local reference sources:

- `packages/telegram-fragment/README.md`
- `packages/telegram-fragment/src/index.ts`
- `packages/telegram-fragment/src/types.ts`
- `apps/docs/app/routes/telegram.tsx`

## Prerequisites

- A database and `@fragno-dev/db` adapter.
- A Telegram bot token from BotFather.
- A public HTTPS webhook URL that Telegram can reach.
- The webhook secret configured both in Telegram and in fragment config.

## Install

`npm install @fragno-dev/telegram-fragment @fragno-dev/db`

## Server setup

1. Create a DB adapter.
2. Build the Telegram config with `createTelegram()` and `defineCommand()`.
3. Instantiate the fragment with `createTelegramFragment(config, { databaseAdapter, mountRoute? })`.
4. Mount the fragment routes in your framework.
5. Generate and apply DB migrations with `fragno-cli`.

Example server module:

```ts
import {
  createTelegram,
  createTelegramFragment,
  defineCommand,
} from "@fragno-dev/telegram-fragment";
import { databaseAdapter } from "./db";

const telegramConfig = createTelegram({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET!,
  botUsername: "my_bot",
  hooks: {
    onMessageReceived: async ({ messageId, chatId }) => {
      console.log("Telegram message", messageId, "in chat", chatId);
    },
  },
})
  .command(
    defineCommand("ping", {
      description: "Ping the bot",
      scopes: ["private", "group", "supergroup"],
      handler: async ({ api, chat }) => {
        await api.sendMessage({ chat_id: chat.id, text: "pong" });
      },
    }),
  )
  .build();

export const telegramFragment = createTelegramFragment(telegramConfig, {
  databaseAdapter,
  mountRoute: "/api/telegram",
});
```

## Database migrations

Generate schema/migrations:

- `npx fragno-cli db generate lib/telegram.ts --format drizzle -o db/telegram.schema.ts`
- `npx fragno-cli db generate lib/telegram.ts --output migrations/001_telegram.sql`

## Client setup

Use the framework-specific client entrypoint, e.g. React:

```ts
import { createTelegramFragmentClient } from "@fragno-dev/telegram-fragment/react";

export const telegramClient = createTelegramFragmentClient({
  mountRoute: "/api/telegram",
});
```

## Routes and hooks

Routes:

- `POST /telegram/webhook`
- `POST /commands/bind`
- `GET /commands`
- `GET /chats`
- `GET /chats/:chatId`
- `GET /chats/:chatId/messages`
- `POST /chats/:chatId/actions`
- `POST /chats/:chatId/send`
- `POST /chats/:chatId/messages/:messageId/edit`

Hooks/mutators:

- `useCommands`
- `useBindCommand`
- `useChats`
- `useChat`
- `useChatMessages`
- `useChatAction`
- `useSendMessage`
- `useEditMessage`

## Security notes

- Telegram webhook requests must send `X-Telegram-Bot-Api-Secret-Token` matching your config.
- Keep the webhook route public, but protect the rest of your app-facing Telegram routes as needed.
- Treat bot tokens and webhook secrets like credentials.

## Common pitfalls

- Forgetting to configure the Telegram webhook to point at the mounted route.
- Using a client `mountRoute` that does not match the server mount.
- Not applying DB migrations before receiving the first webhook.

## Next steps

- Add product-specific commands and per-chat bindings.
- Connect Telegram hooks to workflows or other app automation.
