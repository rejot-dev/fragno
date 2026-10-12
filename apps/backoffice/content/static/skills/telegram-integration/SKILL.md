---
name: telegram-integration
description: >
  Use Telegram through integrations.* (backoffice#telegram) or the telegram.* runtime tools. Load
  with configuring-integrations for bot setup; also use for message.received events, chat replies,
  Telegram files, and hook debugging.
---

# Telegram Integration

Use this skill for the Telegram bot integration: bot setup details, inbound message semantics,
Telegram hook scope, and Telegram actions. Every scope, including system, has its own bot, addressed
as `backoffice#telegram` in that scope.

# Telegram configuration

User-supplied configuration fields:

- `botToken`: Telegram BotFather token. Secret.
- `botUsername`: optional bot username, with or without `@`.
- `apiBaseUrl`: optional Telegram API base URL override.

Backoffice generates the webhook secret during configuration. Integration setup takes
`{ botToken, botUsername }`, with `botUsername` null when unset; the API base URL override is only
available through `connections.*`.

Setup procedure:

1. Tell the user how to register a bot with Telegram:
   - Open a chat with the verified `@BotFather` account in Telegram.
   - Send `/newbot` and follow the prompts to choose a display name and a unique username.
   - Copy the bot token BotFather returns and enter it in the Backoffice Telegram integration.
   - Treat the bot token like a password and regenerate it in BotFather if it is exposed.
2. Save the integration configuration. Backoffice generates a cryptographically secure webhook
   secret, derives the scope's webhook URL, and registers both with Telegram. If Telegram rejects
   the webhook, setup is `blocked`: the token is saved and sending works, but received messages do
   not arrive until a reconfiguration registers the webhook.

`integrations.verify({ connectionId: "backoffice#telegram" })` asks Telegram where it delivers the
bot's updates and fails unless that is this deployment's webhook.

The stored secret must match the `X-Telegram-Bot-Api-Secret-Token` header Telegram sends to the
webhook.

# Telegram events

## Message received

Fires when the Telegram webhook receives a bot message for the organization.

Catalog identity:

- `source`: `telegram`
- `eventType`: `message.received`

Before parsing payloads, inspect the catalog schema with codemode:

```js
const descriptor = await events.catalogGet({ source: "telegram", eventType: "message.received" });
```

Payload fields:

- `messageId`: Telegram message id as a string.
- `chatId`: Telegram chat id as a string. Use this with Telegram chat tools.
- `fromUserId`: Telegram user id when available, otherwise `null`.
- `text`: message text when available, otherwise `null`.
- `attachments`: optional attachment metadata. Voice notes and files are represented here, not as
  raw Telegram `message.voice` fields.

When reading a queued ingest hook through `hooks.get({ fragment: "automations", hookId })`, the
normalized Telegram payload is inside the event envelope:

```js
const entry = await hooks.get({ fragment: "automations", hookId });
const payload = entry?.payload?.payload;
const attachments = payload?.attachments ?? [];
```

Actor:

- `scope`: `external`
- `source`: `telegram`
- `type`: `chat`
- `id`: the Telegram chat id

Common automation pattern: filter on `event.source === "telegram"` and
`event.eventType === "message.received"`, then route slash commands, plain text, or attachments.

## Connection state

Saving a bot reports `connection.ready` and resetting it reports `connection.disconnected`, both
with `source: "integrations"`, `subject.service: "telegram"`, and
`subject.connectionId: "backoffice#telegram"`. Use `connection.ready` to bootstrap Telegram-specific
automation state.

Hook scope: `telegram`.

# Telegram tools

Telegram tools can:

- send chat messages;
- send typing indicators;
- edit existing messages;
- resolve Telegram file metadata;
- download Telegram files.

In new automations, call them as integration actions on `backoffice#telegram`: `messages.send`,
`messages.edit`, `chat-actions.send`, `files.get`, and `files.download`. Read their schemas with
`integrations.actions`. The `telegram` provider methods `sendMessage`, `sendChatAction`,
`editMessage`, `getFile`, and `downloadFile` remain for existing automations.

Example:

```js
await telegram.sendMessage({ chatId, text: "Hello", parseMode: "Markdown" });
```
