import { defineCommand } from "just-bash";

import { createAutomationCommands } from "../automation/commands/bash-adapter";
import {
  assertNoPositionals,
  buildCommandHelp,
  ensureTrailingNewline,
  hasHelpOption,
  parseCliTokens,
  readOutputOptions,
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

const TELEGRAM_COMMAND_NAMES = ["telegram.file.get", "telegram.file.download"] as const;

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

export type TelegramParsedCommandByName = {
  "telegram.file.get": ParsedCommand<"telegram.file.get", TelegramFileGetArgs>;
  "telegram.file.download": ParsedCommand<"telegram.file.download", TelegramFileDownloadArgs>;
};

type TelegramCommandHandlers<TContext = unknown> = AutomationCommandHandlersFor<
  TContext,
  TelegramParsedCommandByName
>;

export type TelegramBashRuntime = {
  getFile: (args: TelegramFileGetArgs) => Promise<TelegramAutomationFileMetadata>;
  downloadFile: (args: TelegramFileDownloadArgs) => Promise<Response>;
};

export type RegisteredTelegramBashCommandContext = {
  runtime: TelegramBashRuntime;
};

const HELP: {
  fileGet: AutomationCommandHelp;
  fileDownload: AutomationCommandHelp;
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
};

const defaultStructuredOutput = (args: string[]) => {
  const parsed = parseCliTokens(args);
  const output = readOutputOptions(parsed);

  return output.print || parsed.options.has("format")
    ? output
    : { ...output, format: "json" as const };
};

const parseTelegramFileGet = (args: string[]): TelegramParsedCommandByName["telegram.file.get"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "telegram.file.get");

  return {
    name: "telegram.file.get",
    args: {
      fileId: readStringOption(parsed, "file-id", true)!,
    },
    output: defaultStructuredOutput(args),
    rawArgs: args,
  };
};

const parseTelegramFileDownload = (
  args: string[],
): TelegramParsedCommandByName["telegram.file.download"] => {
  const parsed = parseCliTokens(args);
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

const telegramFileGetHandler: TelegramCommandHandlers<RegisteredTelegramBashCommandContext>["telegram.file.get"] =
  async (command, context) => {
    return {
      data: await context.runtime.getFile(command.args),
    };
  };

const expandShortFlags = (args: string[]): string[] =>
  args.map((token) => (token === "-o" ? "--output" : token));

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
      [TELEGRAM_COMMAND_SPECS["telegram.file.get"]],
      { "telegram.file.get": telegramFileGetHandler },
      telegramContext,
      input.commandCallsResult,
    ),
    createTelegramDownloadCommand(telegramContext, input.commandCallsResult),
  ];
};

const TELEGRAM_NOT_CONFIGURED = "Telegram is not configured for this organisation.";

export const createTelegramBashRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): TelegramBashRuntime => {
  const telegramDo = env.TELEGRAM.get(env.TELEGRAM.idFromName(orgId));
  return {
    getFile: async (args) => telegramDo.getAutomationFile(args),
    downloadFile: async (args) => telegramDo.downloadAutomationFile(args),
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
});
