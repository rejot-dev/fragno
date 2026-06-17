import { z } from "zod";

import {
  defineCliArgsParser,
  readOutputOptions,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";
import {
  createOrganisationNotConfiguredMessage,
  throwOnHttpResponseError,
} from "@/fragno/runtime-tools/runtime-errors";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

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

export type TelegramQueuedMessageOutput = {
  ok: boolean;
  queued: boolean;
};

export type TelegramActionOutput = {
  ok: boolean;
};

type TelegramDownloadedFile = {
  bytes: number[];
  contentType?: string;
};

export type TelegramRuntime = {
  getFile: (args: TelegramFileGetArgs) => Promise<TelegramAutomationFileMetadata>;
  downloadFile: (args: TelegramFileDownloadArgs) => Promise<Response>;
  sendMessage: (args: TelegramSendMessageArgs) => Promise<TelegramQueuedMessageOutput>;
  sendChatAction: (args: TelegramSendActionArgs) => Promise<TelegramActionOutput>;
  editMessage: (args: TelegramEditMessageArgs) => Promise<TelegramQueuedMessageOutput>;
};

type TelegramFileDownloadBashArgs = TelegramFileDownloadArgs & {
  outputPath?: string;
};

type TelegramToolContext = BackofficeToolContext<{ telegram?: TelegramRuntime }>;

const fileGetInputSchema = z.object({ fileId: z.string().trim().min(1) });
const fileDownloadInputSchema = z.object({ fileId: z.string().trim().min(1) });
const fileMetadataOutputSchema = z.object({
  fileId: z.string().trim().min(1),
  fileUniqueId: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  fileSize: z.number().int().nullable().optional(),
});
const downloadedFileOutputSchema = z.object({
  bytes: z.array(z.number().int().min(0).max(255)),
  contentType: z.string().optional(),
});
const sendMessageInputSchema = z.object({
  chatId: z.string().trim().min(1),
  text: z.string().trim().min(1),
  parseMode: z.enum(["MarkdownV2", "Markdown", "HTML"]).optional(),
  disableWebPagePreview: z.boolean().optional(),
  replyToMessageId: z.number().int().optional(),
});
const sendActionInputSchema = z.object({
  chatId: z.string().trim().min(1),
  action: z.literal("typing"),
});
const editMessageInputSchema = z.object({
  chatId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  text: z.string().trim().min(1),
  parseMode: z.enum(["MarkdownV2", "Markdown", "HTML"]).optional(),
  disableWebPagePreview: z.boolean().optional(),
});
const queuedMessageOutputSchema = z.object({ ok: z.boolean(), queued: z.boolean() });
const actionOutputSchema = z.object({ ok: z.boolean() });

const getTelegramRuntime = (
  runtime: TelegramToolContext["runtimes"]["telegram"],
): TelegramRuntime => {
  if (!runtime) {
    throw new Error("Telegram runtime is not available in this execution context");
  }
  return runtime;
};

const expandTelegramShortFlags = (args: string[]): string[] =>
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

const defaultStructuredOutput = (_args: string[], parsed: ParsedCliTokens) => {
  const output = readOutputOptions(parsed);

  return output.print || parsed.options.has("format")
    ? output
    : { ...output, format: "json" as const };
};

const parseModeField = {
  option: "parse-mode",
  transform: (value: string) => z.enum(["MarkdownV2", "Markdown", "HTML"]).parse(value),
};

const telegramParserOptions = { normalizeArgs: expandTelegramShortFlags };

const readFlagPresence = (name: string) => (parsed: ParsedCliTokens) =>
  parsed.options.has(name) ? true : undefined;

const parseTelegramFileGet = defineCliArgsParser<TelegramFileGetArgs>(
  "telegram.file.get",
  { fileId: { required: true } },
  telegramParserOptions,
);

const parseTelegramFileDownloadBashArgs = defineCliArgsParser<TelegramFileDownloadBashArgs>(
  "telegram.file.download",
  {
    fileId: { required: true },
    outputPath: { option: "output" },
  },
  telegramParserOptions,
);

const parseTelegramFileDownload = (args: string[]): TelegramFileDownloadArgs => {
  const { fileId } = parseTelegramFileDownloadBashArgs(args);
  return { fileId };
};

const parseTelegramChatSend = defineCliArgsParser<TelegramSendMessageArgs>(
  "telegram.chat.send",
  {
    chatId: { required: true },
    text: { required: true },
    parseMode: { ...parseModeField, defaultValue: "Markdown" },
    disableWebPagePreview: { read: readFlagPresence("disable-web-page-preview") },
    replyToMessageId: { kind: "integer" },
  },
  telegramParserOptions,
);

const parseTelegramChatActions = defineCliArgsParser<TelegramSendActionArgs>(
  "telegram.chat.actions",
  {
    chatId: { required: true },
    action: {
      required: true,
      transform: (value) => {
        if (value !== "typing") {
          throw new Error(`Unsupported Telegram chat action: ${value || "(empty)"}`);
        }
        return "typing";
      },
    },
  },
  telegramParserOptions,
);

const parseTelegramMessageEdit = defineCliArgsParser<TelegramEditMessageArgs>(
  "telegram.message.edit",
  {
    chatId: { required: true },
    messageId: { required: true },
    text: { required: true },
    parseMode: parseModeField,
    disableWebPagePreview: { read: readFlagPresence("disable-web-page-preview") },
  },
  telegramParserOptions,
);

const dataFormat = <T>(result: T) => ({ data: result });

const TELEGRAM_NOT_CONFIGURED = createOrganisationNotConfiguredMessage("Telegram");

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

const throwOnTelegramDownloadError = async (response: Response): Promise<never> => {
  return throwOnHttpResponseError(response, {
    runtimeLabel: "Telegram fragment",
    label: "telegram.file.download",
    notConfiguredMessage: TELEGRAM_NOT_CONFIGURED,
  });
};

const readTelegramDownload = async (response: Response): Promise<TelegramDownloadedFile> => {
  if (!response.ok) {
    throw new Error(`Telegram file download failed with status ${response.status}`);
  }

  return {
    bytes: [...new Uint8Array(await response.arrayBuffer())],
    contentType: response.headers.get("content-type") ?? undefined,
  };
};

export const telegramRuntimeTools = [
  defineBackofficeRuntimeTool({
    id: "telegram.file.get",
    namespace: "telegram",
    name: "getFile",
    description: "Resolve Telegram attachment metadata.",
    inputSchema: fileGetInputSchema,
    outputSchema: fileMetadataOutputSchema,
    execute: async (input, context: TelegramToolContext) =>
      await getTelegramRuntime(context.runtimes.telegram).getFile(input),
    adapters: {
      bash: {
        command: "telegram.file.get",
        help: {
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
        parse: parseTelegramFileGet,
        outputOptions: defaultStructuredOutput,
        format: dataFormat,
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "telegram.file.download",
    namespace: "telegram",
    name: "downloadFile",
    description: "Download a Telegram file and return its bytes.",
    inputSchema: fileDownloadInputSchema,
    outputSchema: downloadedFileOutputSchema,
    execute: async (input, context: TelegramToolContext) =>
      await readTelegramDownload(
        await getTelegramRuntime(context.runtimes.telegram).downloadFile(input),
      ),
    adapters: {
      bash: {
        command: "telegram.file.download",
        help: {
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
        parse: parseTelegramFileDownload,
        execute: async ({ args, context, shell }) => {
          const { fileId, outputPath } = parseTelegramFileDownloadBashArgs(args);
          const response = await getTelegramRuntime(context.runtimes.telegram).downloadFile({
            fileId,
          });
          if (!response.ok) {
            await throwOnTelegramDownloadError(response);
          }

          const bytes = new Uint8Array(await response.arrayBuffer());
          if (outputPath) {
            const resolvedPath = shell.fs.resolvePath(shell.cwd, outputPath);
            await shell.fs.writeFile(resolvedPath, bytes);
            return { stdout: `Downloaded ${bytes.byteLength} bytes to ${resolvedPath}\n` };
          }

          return {
            stdout: bytesToBinaryString(bytes),
            stdoutEncoding: "binary" as const,
          };
        },
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "telegram.chat.send",
    namespace: "telegram",
    name: "sendMessage",
    description: "Queue a message to be sent to a Telegram chat.",
    inputSchema: sendMessageInputSchema,
    outputSchema: queuedMessageOutputSchema,
    execute: async (input, context: TelegramToolContext) =>
      await getTelegramRuntime(context.runtimes.telegram).sendMessage(input),
    adapters: {
      bash: {
        command: "telegram.chat.send",
        help: {
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
        parse: parseTelegramChatSend,
        outputOptions: defaultStructuredOutput,
        format: dataFormat,
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "telegram.chat.actions",
    namespace: "telegram",
    name: "sendChatAction",
    description: "Send a Telegram chat action.",
    inputSchema: sendActionInputSchema,
    outputSchema: actionOutputSchema,
    execute: async (input, context: TelegramToolContext) =>
      await getTelegramRuntime(context.runtimes.telegram).sendChatAction(input),
    adapters: {
      bash: {
        command: "telegram.chat.actions",
        help: {
          summary:
            "telegram.chat.actions sends a chat action (only typing is supported currently).",
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
        parse: parseTelegramChatActions,
        outputOptions: defaultStructuredOutput,
        format: dataFormat,
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "telegram.message.edit",
    namespace: "telegram",
    name: "editMessage",
    description: "Queue an edit of an existing Telegram message.",
    inputSchema: editMessageInputSchema,
    outputSchema: queuedMessageOutputSchema,
    execute: async (input, context: TelegramToolContext) =>
      await getTelegramRuntime(context.runtimes.telegram).editMessage(input),
    adapters: {
      bash: {
        command: "telegram.message.edit",
        help: {
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
          examples: [
            'telegram.message.edit --chat-id "$chat_id" --message-id 123 --text "Updated text"',
          ],
        },
        parse: parseTelegramMessageEdit,
        outputOptions: defaultStructuredOutput,
        format: dataFormat,
      },
    },
  }),
] as const;

export const telegramToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "telegram",
  tools: telegramRuntimeTools,
  isAvailable: (context: TelegramToolContext) => !!context.runtimes.telegram,
});
