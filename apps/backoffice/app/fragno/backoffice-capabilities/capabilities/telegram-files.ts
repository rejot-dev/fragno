import { skillFiles } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const createTelegramCapabilityFiles = () =>
  skillFiles({
    name: "telegram-connection",
    title: "Telegram Connection",
    description:
      "Configure and automate the Backoffice Telegram bot capability. Use when setting up Telegram, handling telegram:message.received events, sending chat replies, downloading Telegram files, or debugging Telegram hooks and runtime tools.",
    overview:
      "Use this skill for the organisation-scoped Telegram bot integration: bot setup details, inbound message semantics, Telegram hook scope, and Telegram-specific runtime tool purposes.",
    configuration: `# Telegram configuration

Configuration fields:

- \`botToken\`: Telegram BotFather token. Secret.
- \`webhookSecretToken\`: long random token Telegram includes with webhook requests. Secret.
- \`webhookBaseUrl\`: public Backoffice origin or tunnel URL used to register the Telegram webhook.
- \`botUsername\`: optional bot username, with or without \`@\`.
- \`apiBaseUrl\`: optional Telegram API base URL override.

Setup notes:

- Create the bot in BotFather before configuring the connection.
- The webhook secret must match the token sent by Telegram on webhook requests.
- The webhook base URL must be reachable by Telegram.
`,
    events: `# Telegram events

## telegram:message.received

Fires when the Telegram webhook receives a bot message for the organisation.

Payload fields:

- \`messageId\`: Telegram message id as a string.
- \`chatId\`: Telegram chat id as a string. Use this with Telegram chat tools.
- \`fromUserId\`: Telegram user id when available, otherwise \`null\`.
- \`text\`: message text when available, otherwise \`null\`.
- \`attachments\`: optional attachment metadata.

Actor:

- \`scope\`: \`external\`
- \`source\`: \`telegram\`
- \`type\`: \`chat\`
- \`id\`: the Telegram chat id

Common automation pattern: filter on \`event.source === "telegram"\` and \`event.eventType === "message.received"\`, then route slash commands or plain text.

## telegram:capability.configured

Fires after Telegram is configured for an organisation for the first time. Use it to bootstrap Telegram-specific automation state.

Hook scope: \`telegram\`.
`,
    tools: `# Telegram tools

Telegram tools can:

- send chat messages;
- send typing indicators;
- edit existing messages;
- resolve Telegram file metadata;
- download Telegram files.

Use codemode first. The \`telegram\` provider methods are \`sendMessage\`, \`sendChatAction\`, \`editMessage\`, \`getFile\`, and \`downloadFile\`.

Example:

\`\`\`js
await telegram.sendMessage({ chatId, text: "Hello", parseMode: "Markdown" });
\`\`\`
`,
  });
