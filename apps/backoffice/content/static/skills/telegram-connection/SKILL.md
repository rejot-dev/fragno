---
name: telegram-connection
description:
  Configure and automate the Backoffice Telegram bot capability. Use when setting up Telegram,
  handling events with source "telegram" and eventType "message.received", sending chat replies,
  downloading Telegram files, or debugging Telegram hooks and runtime tools.
---

# Telegram Connection

Use this skill for the organization-scoped Telegram bot integration: bot setup details, inbound
message semantics, Telegram hook scope, and Telegram-specific runtime tool purposes.

# Telegram configuration

Configuration fields:

- `botToken`: Telegram BotFather token. Secret.
- `webhookSecretToken`: long random token Telegram includes with webhook requests. Secret.
- `botUsername`: optional bot username, with or without `@`.
- `apiBaseUrl`: optional Telegram API base URL override.

Setup procedure:

1. Tell the user how to register a bot with Telegram:
   - Open a chat with the verified `@BotFather` account in Telegram.
   - Send `/newbot` and follow the prompts to choose a display name and a unique username.
   - Copy the bot token BotFather returns and enter it in the Backoffice Telegram connection.
   - Treat the bot token like a password and regenerate it in BotFather if it is exposed.
2. Generate a cryptographically secure, high-entropy `webhookSecretToken` automatically. Do not ask
   the user to invent or supply this secret.
3. Save the connection configuration. Backoffice derives and registers the organisation-scoped
   webhook URL with Telegram and supplies the generated secret as Telegram's `secret_token`.

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

When reading a queued ingest hook through `internal.hooksGet({ fragment: "automations", hookId })`,
the normalized Telegram payload is inside the event envelope:

```js
const entry = await internal.hooksGet({ fragment: "automations", hookId });
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

## Capability configured

Fires after Telegram is configured for an organization for the first time. Use it to bootstrap
Telegram-specific automation state.

Catalog identity:

- `source`: `telegram`
- `eventType`: `capability.configured`

Hook scope: `telegram`.

# Telegram tools

Telegram tools can:

- send chat messages;
- send typing indicators;
- edit existing messages;
- resolve Telegram file metadata;
- download Telegram files.

Use codemode first. The `telegram` provider methods are `sendMessage`, `sendChatAction`,
`editMessage`, `getFile`, and `downloadFile`.

Example:

```js
await telegram.sendMessage({ chatId, text: "Hello", parseMode: "Markdown" });
```
