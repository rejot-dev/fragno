import { createRouteCaller } from "@fragno-dev/core/api";
import { defineCommand } from "just-bash";

import type { TelegramFragment } from "@/fragno/telegram";

import { createAutomationCommands } from "../automation/commands/bash-adapter";
import {
  assertNoPositionals,
  buildCommandHelp,
  ensureTrailingNewline,
  hasHelpOption,
  parseCliTokens,
  readOutputOptions,
  readIntegerOption,
  readStringOption,
} from "../automation/commands/cli";
import type {
  AutomationCommandHelp,
  AutomationCommandHandlersFor,
  AutomationCommandSpec,
  BashAutomationCommandResult,
  ParsedCommand,
} from "../automation/commands/types";
import type { BashCommandFactoryInput } from "./bash-host";

const TELEGRAM_COMMAND_NAMES = [
  "telegram.file.get",
  "telegram.file.download",
  "telegram.chat.send",
  "telegram.chat.actions",
  "telegram.message.edit",
] as const;

export type TelegramCommandName = (typeof TELEGRAM_COMMAND_NAMES)[number];

export type TelegramFileGetArgs = {
  fileId: string;
};

export type TelegramFileDownloadArgs = {
  fileId: string;
};

export type TelegramAutomationFileMetadata = {
  fileId: string;
  fileUniqueId?: string | null;
  filePath?: string | null;
  fileSize?: number | null;
};

export type TelegramSendMessageArgs = {
  chatId: string;
  text: string;
  parseMode?: "MarkdownV2" | "Markdown" | "HTML";
  disableWebPagePreview?: boolean;
  replyToMessageId?: number;
};

export type TelegramSendActionArgs = {
  chatId: string;
  action: "typing";
};

export type TelegramEditMessageArgs = {
  chatId: string;
  messageId: string;
  text: string;
  parseMode?: "MarkdownV2" | "Markdown" | "HTML";
  disableWebPagePreview?: boolean;
};

type TelegramQueuedMessageOutput = {
  ok: boolean;
  queued: boolean;
};

type TelegramActionOutput = {
  ok: boolean;
};

export type TelegramParsedCommandByName = {
  "telegram.file.get": ParsedCommand<"telegram.file.get", TelegramFileGetArgs>;
  "telegram.file.download": ParsedCommand<"telegram.file.download", TelegramFileDownloadArgs>;
  "telegram.chat.send": ParsedCommand<"telegram.chat.send", TelegramSendMessageArgs>;
  "telegram.chat.actions": ParsedCommand<"telegram.chat.actions", TelegramSendActionArgs>;
  "telegram.message.edit": ParsedCommand<"telegram.message.edit", TelegramEditMessageArgs>;
};

type TelegramCommandHandlers<TContext = unknown> = AutomationCommandHandlersFor<
  TContext,
  TelegramParsedCommandByName
>;

export type TelegramBashRuntime = {
  getFile: (args: TelegramFileGetArgs) => Promise<TelegramAutomationFileMetadata>;
  downloadFile: (args: TelegramFileDownloadArgs) => Promise<Response>;
  sendMessage: (args: TelegramSendMessageArgs) => Promise<TelegramQueuedMessageOutput>;
  sendChatAction: (args: TelegramSendActionArgs) => Promise<TelegramActionOutput>;
  editMessage: (args: TelegramEditMessageArgs) => Promise<TelegramQueuedMessageOutput>;
};

export type RegisteredTelegramBashCommandContext = {
  runtime: TelegramBashRuntime;
};

const HELP: {
  fileGet: AutomationCommandHelp;
  fileDownload: AutomationCommandHelp;
  chatSend: AutomationCommandHelp;
  chatActions: AutomationCommandHelp;
  messageEdit: AutomationCommandHelp;
} = {
  fileGet: {
    summary:
      "telegram.file.get resolves Telegram attachment metadata through the Telegram Durable Object.",
    options: [
      {
        name: "file-id",
        required: true,
        valueRequired: true,
        valueName: "file-id",
        description: "Telegram file id to resolve",
      },
    ],
    examples: [
      'telegram.file.get --file-id "$file_id"',
      'telegram.file.get --file-id "$file_id" --print filePath',
    ],
  },
  fileDownload: {
    summary:
      "telegram.file.download fetches a Telegram file. Use --output (-o) to write directly to a path, or pipe stdout for shell redirections.",
    options: [
      {
        name: "file-id",
        required: true,
        valueRequired: true,
        valueName: "file-id",
        description: "Telegram file id to download",
      },
      {
        name: "output",
        valueRequired: true,
        valueName: "path",
        description: "Write file directly to this path instead of stdout (-o shorthand)",
      },
    ],
    examples: [
      'telegram.file.download --file-id "$file_id" -o /workspace/attachment.bin',
      'telegram.file.download --file-id "$file_id" --output /workspace/photo.jpg',
      'telegram.file.download --file-id "$file_id" > /workspace/attachment.bin',
    ],
  },
  chatSend: {
    summary: "telegram.chat.send queues a message to be sent to a Telegram chat.",
    options: [
      {
        name: "chat-id",
        required: true,
        valueRequired: true,
        valueName: "chat-id",
        description: "Telegram chat id to send to",
      },
      {
        name: "text",
        required: true,
        valueRequired: true,
        valueName: "text",
        description: "Message text",
      },
      {
        name: "parse-mode",
        valueRequired: true,
        valueName: "mode",
        description: "Parse mode (Markdown|MarkdownV2|HTML). Defaults to Markdown.",
      },
      {
        name: "disable-web-page-preview",
        description: "Disable web page previews for links",
      },
      {
        name: "reply-to-message-id",
        valueRequired: true,
        valueName: "message-id",
        description: "Reply to this Telegram message id",
      },
    ],
    examples: [
      'telegram.chat.send --chat-id "$chat_id" --text "Hello from bash"',
      'telegram.chat.send --chat-id "$chat_id" --text "<b>Hello</b>" --parse-mode HTML',
    ],
  },
  chatActions: {
    summary: "telegram.chat.actions sends a chat action (only typing is supported currently).",
    options: [
      {
        name: "chat-id",
        required: true,
        valueRequired: true,
        valueName: "chat-id",
        description: "Telegram chat id",
      },
      {
        name: "action",
        valueRequired: true,
        valueName: "action",
        description: "Action to send (typing only for now)",
      },
    ],
    examples: [
      'telegram.chat.actions --chat-id "$chat_id" --action typing',
      'telegram.chat.actions --chat-id "$chat_id" --action typing --format json',
    ],
  },
  messageEdit: {
    summary: "telegram.message.edit queues an edit of an existing Telegram message.",
    options: [
      {
        name: "chat-id",
        required: true,
        valueRequired: true,
        valueName: "chat-id",
        description: "Telegram chat id",
      },
      {
        name: "message-id",
        required: true,
        valueRequired: true,
        valueName: "message-id",
        description: "Telegram message id to edit",
      },
      {
        name: "text",
        required: true,
        valueRequired: true,
        valueName: "text",
        description: "New message text",
      },
      {
        name: "parse-mode",
        valueRequired: true,
        valueName: "mode",
        description: "Parse mode (MarkdownV2|Markdown|HTML)",
      },
      {
        name: "disable-web-page-preview",
        description: "Disable web page previews for links",
      },
    ],
    examples: ['telegram.message.edit --chat-id "$chat_id" --message-id 123 --text "Updated text"'],
  },
};

const defaultStructuredOutput = (args: string[]) => {
  const parsed = parseCliTokens(args);
  const output = readOutputOptions(parsed);

  return output.print || parsed.options.has("format")
    ? output
    : { ...output, format: "json" as const };
};

const parseTelegramFileGet = (args: string[]): TelegramParsedCommandByName["telegram.file.get"] => {
  const parsed = parseCliTokens(expandShortFlags(args));
  assertNoPositionals(parsed, "telegram.file.get");

  return {
    name: "telegram.file.get",
    args: {
      fileId: readStringOption(parsed, "file-id", true)!,
    },
    output: defaultStructuredOutput(expandShortFlags(args)),
    rawArgs: args,
  };
};

const parseTelegramFileDownload = (
  args: string[],
): TelegramParsedCommandByName["telegram.file.download"] => {
  const parsed = parseCliTokens(expandShortFlags(args));
  assertNoPositionals(parsed, "telegram.file.download");

  return {
    name: "telegram.file.download",
    args: {
      fileId: readStringOption(parsed, "file-id", true)!,
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

const parseTelegramChatSend = (
  args: string[],
): TelegramParsedCommandByName["telegram.chat.send"] => {
  const parsed = parseCliTokens(expandShortFlags(args));
  assertNoPositionals(parsed, "telegram.chat.send");

  const disableWebPagePreview = parsed.options.has("disable-web-page-preview");
  const replyToMessageId = readIntegerOption(parsed, "reply-to-message-id");
  const parseMode =
    (readStringOption(parsed, "parse-mode") as TelegramSendMessageArgs["parseMode"]) ?? "Markdown";

  return {
    name: "telegram.chat.send",
    args: {
      chatId: readStringOption(parsed, "chat-id", true)!,
      text: readStringOption(parsed, "text", true)!,
      parseMode,
      ...(disableWebPagePreview ? { disableWebPagePreview: true } : {}),
      ...(typeof replyToMessageId === "number" ? { replyToMessageId } : {}),
    },
    output: defaultStructuredOutput(expandShortFlags(args)),
    rawArgs: args,
  };
};

const parseTelegramChatActions = (
  args: string[],
): TelegramParsedCommandByName["telegram.chat.actions"] => {
  const parsed = parseCliTokens(expandShortFlags(args));
  assertNoPositionals(parsed, "telegram.chat.actions");

  const actionRaw = (readStringOption(parsed, "action", true) ?? "").trim();
  if (actionRaw !== "typing") {
    throw new Error(`Unsupported Telegram chat action: ${actionRaw || "(empty)"}`);
  }

  return {
    name: "telegram.chat.actions",
    args: {
      chatId: readStringOption(parsed, "chat-id", true)!,
      action: "typing",
    },
    output: defaultStructuredOutput(expandShortFlags(args)),
    rawArgs: args,
  };
};

const parseTelegramMessageEdit = (
  args: string[],
): TelegramParsedCommandByName["telegram.message.edit"] => {
  const parsed = parseCliTokens(expandShortFlags(args));
  assertNoPositionals(parsed, "telegram.message.edit");

  const disableWebPagePreview = parsed.options.has("disable-web-page-preview");

  return {
    name: "telegram.message.edit",
    args: {
      chatId: readStringOption(parsed, "chat-id", true)!,
      messageId: readStringOption(parsed, "message-id", true)!,
      text: readStringOption(parsed, "text", true)!,
      parseMode: readStringOption(parsed, "parse-mode") as TelegramEditMessageArgs["parseMode"],
      ...(disableWebPagePreview ? { disableWebPagePreview: true } : {}),
    },
    output: defaultStructuredOutput(expandShortFlags(args)),
    rawArgs: args,
  };
};

const TELEGRAM_COMMAND_SPECS = {
  "telegram.file.get": {
    name: "telegram.file.get",
    help: HELP.fileGet,
    parse: parseTelegramFileGet,
  },
  "telegram.file.download": {
    name: "telegram.file.download",
    help: HELP.fileDownload,
    parse: parseTelegramFileDownload,
  },
  "telegram.chat.send": {
    name: "telegram.chat.send",
    help: HELP.chatSend,
    parse: parseTelegramChatSend,
  },
  "telegram.chat.actions": {
    name: "telegram.chat.actions",
    help: HELP.chatActions,
    parse: parseTelegramChatActions,
  },
  "telegram.message.edit": {
    name: "telegram.message.edit",
    help: HELP.messageEdit,
    parse: parseTelegramMessageEdit,
  },
} satisfies {
  [TCommandName in TelegramCommandName]: AutomationCommandSpec<
    TCommandName,
    TelegramParsedCommandByName[TCommandName]["args"]
  > & {
    parse: (args: string[]) => TelegramParsedCommandByName[TCommandName];
  };
};

const bytesToBinaryString = (bytes: Uint8Array) => {
  if (bytes.byteLength === 0) {
    return "";
  }

  const chunkSize = 0x8000;
  let result = "";
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return result;
};

const telegramCommandHandlers: TelegramCommandHandlers<RegisteredTelegramBashCommandContext> = {
  "telegram.file.get": async (command, context) => {
    return {
      data: await context.runtime.getFile(command.args),
    };
  },
  "telegram.file.download": async () => {
    throw new Error("telegram.file.download is handled by a custom bash command.");
  },
  "telegram.chat.send": async (command, context) => {
    return {
      data: await context.runtime.sendMessage(command.args),
    };
  },
  "telegram.chat.actions": async (command, context) => {
    return {
      data: await context.runtime.sendChatAction(command.args),
    };
  },
  "telegram.message.edit": async (command, context) => {
    return {
      data: await context.runtime.editMessage(command.args),
    };
  },
};

const expandShortFlags = (args: string[]): string[] =>
  args.map((token) => {
    if (token === "-o") {
      return "--output";
    }
    if (token === "-c") {
      return "--chat-id";
    }
    if (token === "-t") {
      return "--text";
    }
    return token;
  });

const createTelegramDownloadCommand = (
  telegramContext: RegisteredTelegramBashCommandContext,
  commandCallsResult: BashAutomationCommandResult[],
) => {
  const spec = TELEGRAM_COMMAND_SPECS["telegram.file.download"];

  return defineCommand("telegram.file.download", async (args, ctx) => {
    const normalizedArgs = expandShortFlags(args);
    const parsed = parseCliTokens(normalizedArgs);

    if (hasHelpOption(parsed)) {
      const helpText = buildCommandHelp(spec);
      commandCallsResult.push({
        command: spec.name,
        output: helpText.replace(/\n$/, ""),
        exitCode: 0,
      });
      return { stdout: helpText, stderr: "", exitCode: 0 };
    }

    try {
      assertNoPositionals(parsed, "telegram.file.download");
      const fileId = readStringOption(parsed, "file-id", true)!;
      const outputPath = readStringOption(parsed, "output");

      const response = await telegramContext.runtime.downloadFile({ fileId });
      const bytes = new Uint8Array(await response.arrayBuffer());

      if (outputPath) {
        const resolvedPath = ctx.fs.resolvePath(ctx.cwd, outputPath);
        await ctx.fs.writeFile(resolvedPath, bytes);

        const message = `Downloaded ${bytes.byteLength} bytes to ${resolvedPath}\n`;
        commandCallsResult.push({
          command: spec.name,
          output: message.replace(/\n$/, ""),
          exitCode: 0,
        });
        return { stdout: message, stderr: "", exitCode: 0 };
      }

      commandCallsResult.push({
        command: spec.name,
        output: "<binary>",
        exitCode: 0,
      });
      return {
        stdout: bytesToBinaryString(bytes),
        stderr: "",
        exitCode: 0,
        stdoutEncoding: "binary" as const,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      commandCallsResult.push({
        command: spec.name,
        output: "",
        exitCode: 1,
      });
      return {
        stdout: "",
        stderr: ensureTrailingNewline(message),
        exitCode: 1,
      };
    }
  });
};

export const createTelegramBashCommands = (input: BashCommandFactoryInput) => {
  const telegramContext = input.context.telegram;
  if (!telegramContext) {
    return [];
  }

  return [
    ...createAutomationCommands(
      [
        TELEGRAM_COMMAND_SPECS["telegram.file.get"],
        TELEGRAM_COMMAND_SPECS["telegram.chat.send"],
        TELEGRAM_COMMAND_SPECS["telegram.chat.actions"],
        TELEGRAM_COMMAND_SPECS["telegram.message.edit"],
      ],
      telegramCommandHandlers,
      telegramContext,
      input.commandCallsResult,
    ),
    createTelegramDownloadCommand(telegramContext, input.commandCallsResult),
  ];
};

const TELEGRAM_NOT_CONFIGURED = "Telegram is not configured for this organisation.";

type CreateRouteBackedTelegramRuntimeOptions = {
  baseUrl: string;
  headers?: HeadersInit;
  fetch(request: Request): Promise<Response>;
};

export type TelegramRouteBackedCommands = Pick<
  TelegramBashRuntime,
  "sendMessage" | "sendChatAction" | "editMessage"
>;

const createTelegramRouteCaller = (
  options: Pick<CreateRouteBackedTelegramRuntimeOptions, "baseUrl" | "headers" | "fetch">,
) => {
  return createRouteCaller<TelegramFragment>({
    baseUrl: options.baseUrl,
    mountRoute: "/api/telegram",
    ...(options.headers ? { baseHeaders: options.headers } : {}),
    fetch: options.fetch,
  });
};

const isSuccessStatus = (status: number) => status >= 200 && status < 300;

const getJsonErrorField = (value: unknown, field: "message" | "code") => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const resolved = (value as Record<string, unknown>)[field];
  return typeof resolved === "string" && resolved.trim() ? resolved : null;
};

const throwOnRouteError = (
  response:
    | ({ type: string; status: number } & {
        type: "error";
        error: { message: string; code: string };
      })
    | ({ type: string; status: number } & { type: "json"; data: unknown })
    | { type: string; status: number },
  label: string,
): never => {
  const code =
    "error" in response
      ? getJsonErrorField(response.error, "code")
      : "data" in response
        ? getJsonErrorField(response.data, "code")
        : null;
  const message =
    "error" in response
      ? getJsonErrorField(response.error, "message")
      : "data" in response
        ? getJsonErrorField(response.data, "message")
        : null;

  if (response.status === 400 && code === "NOT_CONFIGURED") {
    throw new Error(message ?? "Telegram is not configured.");
  }

  if (message) {
    throw new Error(`Telegram fragment returned ${response.status}: ${message}`);
  }

  throw new Error(`Telegram fragment returned ${response.status} (${label})`);
};

export const createRouteBackedTelegramBashRuntime = (
  options: CreateRouteBackedTelegramRuntimeOptions,
): TelegramRouteBackedCommands => {
  const baseUrl = options.baseUrl.trim();
  if (!baseUrl) {
    throw new Error("Telegram runtime requires a base URL");
  }

  const callRoute = createTelegramRouteCaller({
    baseUrl,
    headers: options.headers,
    fetch: options.fetch,
  });

  return {
    sendMessage: async ({ chatId, text, parseMode, disableWebPagePreview, replyToMessageId }) => {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        throw new Error("telegram.chat.send requires a chat id");
      }
      const normalizedText = text.trim();
      if (!normalizedText) {
        throw new Error("telegram.chat.send requires non-empty text");
      }

      const response = await callRoute("POST", "/chats/:chatId/send", {
        pathParams: { chatId: normalizedChatId },
        body: {
          text: normalizedText,
          ...(parseMode ? { parseMode } : {}),
          ...(disableWebPagePreview ? { disableWebPagePreview: true } : {}),
          ...(typeof replyToMessageId === "number" ? { replyToMessageId } : {}),
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteError(response, "telegram.chat.send");
    },
    sendChatAction: async ({ chatId, action }) => {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        throw new Error("telegram.chat.actions requires a chat id");
      }
      if (action !== "typing") {
        throw new Error(`Unsupported Telegram chat action: ${action}`);
      }

      const response = await callRoute("POST", "/chats/:chatId/actions", {
        pathParams: { chatId: normalizedChatId },
        body: { action: "typing" },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteError(response, "telegram.chat.actions");
    },
    editMessage: async ({ chatId, messageId, text, parseMode, disableWebPagePreview }) => {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        throw new Error("telegram.message.edit requires a chat id");
      }
      const normalizedMessageId = messageId.trim();
      if (!normalizedMessageId) {
        throw new Error("telegram.message.edit requires a message id");
      }
      const normalizedText = text.trim();
      if (!normalizedText) {
        throw new Error("telegram.message.edit requires non-empty text");
      }

      const response = await callRoute("POST", "/chats/:chatId/messages/:messageId/edit", {
        pathParams: { chatId: normalizedChatId, messageId: normalizedMessageId },
        body: {
          text: normalizedText,
          ...(parseMode ? { parseMode } : {}),
          ...(disableWebPagePreview ? { disableWebPagePreview: true } : {}),
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteError(response, "telegram.message.edit");
    },
  };
};

export const createTelegramBashRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): TelegramBashRuntime => {
  const telegramDo = env.TELEGRAM.get(env.TELEGRAM.idFromName(orgId));
  const routeBacked = createRouteBackedTelegramBashRuntime({
    baseUrl: "https://telegram.do",
    fetch: async (outboundRequest) => telegramDo.fetch(outboundRequest),
  });

  return {
    getFile: async (input) => telegramDo.getAutomationFile(input),
    downloadFile: async (input) => telegramDo.downloadAutomationFile(input),
    ...routeBacked,
  };
};

export const createUnavailableTelegramBashRuntime = (
  message = TELEGRAM_NOT_CONFIGURED,
): TelegramBashRuntime => ({
  getFile: async () => {
    throw new Error(message);
  },
  downloadFile: async () => {
    throw new Error(message);
  },
  sendMessage: async () => {
    throw new Error(message);
  },
  sendChatAction: async () => {
    throw new Error(message);
  },
  editMessage: async () => {
    throw new Error(message);
  },
});
