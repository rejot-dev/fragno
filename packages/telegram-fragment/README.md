# telegram-fragment

Fragno fragment for Telegram bots with chat tracking, command registry, and durable hooks.

## Configuration

```ts
import {
  createTelegramFragment,
  createTelegram,
  defineCommand,
} from "@fragno-dev/telegram-fragment";

const telegramConfig = createTelegram({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET!,
  botUsername: "my_bot",
  hooks: {
    onMessageReceived: async ({ messageId, chatId }) => {
      console.log("Message", messageId, "in chat", chatId);
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

const fragment = createTelegramFragment(telegramConfig, {
  databaseAdapter: "drizzle-pglite",
});
```

## Webhook

Incoming updates must include the header:

- `X-Telegram-Bot-Api-Secret-Token: <webhookSecretToken>`

Webhook route: `POST /telegram/webhook`

## Hooks

- `onMessageReceived`
- `onCommandMatched`
- `onChatMemberUpdated`

## Routes

- `POST /telegram/webhook`
- `POST /commands/bind`
- `GET /commands`
- `GET /chats`
- `GET /chats/:chatId`
- `GET /chats/:chatId/messages`
- `POST /chats/:chatId/actions`
- `POST /chats/:chatId/send`
- `POST /chats/:chatId/messages/:messageId/edit`

## Data model

All Telegram IDs are stored in `idColumn()` fields (no separate telegram_id columns).

- `user` (id = telegram user id)
- `chat` (id = telegram chat id)
- `chatMember` (id = `${chatId}:${userId}`)
- `message` (id = `${chatId}:${messageId}`)
- `chat.commandBindings` (json registry of per-chat command settings)

## Build

```bash
npm run types:check
npm run build
```

## Test

```bash
npm run test
```
