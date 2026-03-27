import { createRouteCaller } from "@fragno-dev/core/api";
import { defineCommand } from "just-bash";

import type {
  Reson8PrerecordedQuery,
  Reson8PrerecordedTranscription,
} from "@fragno-dev/reson8-fragment";

import type { Reson8Fragment } from "@/fragno/reson8";

import { createAutomationCommands } from "../automation/commands/bash-adapter";
import {
  assertNoPositionals,
  buildCommandHelp,
  ensureTrailingNewline,
  formatCommandStdout,
  hasHelpOption,
  normalizeExecutionResult,
  parseCliTokens,
  readIntegerOption,
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

const RESON8_COMMAND_NAMES = ["reson8.prerecorded.transcribe"] as const;

export type Reson8CommandName = (typeof RESON8_COMMAND_NAMES)[number];

export type Reson8PrerecordedTranscribeArgs = {
  inputPath: string;
  encoding?: Reson8PrerecordedQuery["encoding"];
  sampleRate?: number;
  channels?: number;
  customModelId?: string;
  includeTimestamps?: boolean;
  includeWords?: boolean;
  includeConfidence?: boolean;
};

export type Reson8BashRuntime = {
  transcribePrerecorded: (args: {
    audio: ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>;
    query?: Record<string, string>;
  }) => Promise<Reson8PrerecordedTranscription>;
};

export type RegisteredReson8BashCommandContext = {
  runtime: Reson8BashRuntime;
};

type CreateRouteBackedReson8RuntimeOptions = {
  baseUrl: string;
  headers?: HeadersInit;
  fetch(request: Request): Promise<Response>;
};

type Reson8ParsedCommandByName = {
  "reson8.prerecorded.transcribe": ParsedCommand<
    "reson8.prerecorded.transcribe",
    Reson8PrerecordedTranscribeArgs
  >;
};

type Reson8CommandHandlers<TContext = unknown> = AutomationCommandHandlersFor<
  TContext,
  Reson8ParsedCommandByName
>;

const HELP: { prerecordedTranscribe: AutomationCommandHelp } = {
  prerecordedTranscribe: {
    summary:
      "reson8.prerecorded.transcribe transcribes a prerecorded audio file via the Reson8 fragment /speech-to-text/prerecorded route.",
    options: [
      {
        name: "input",
        required: true,
        valueRequired: true,
        valueName: "path",
        description: "Path to the audio file inside the bash filesystem",
      },
      {
        name: "encoding",
        valueRequired: true,
        valueName: "encoding",
        description: 'Audio encoding ("auto" or "pcm_s16le")',
      },
      {
        name: "sample-rate",
        valueRequired: true,
        valueName: "hz",
        description: "Sample rate as a positive integer (e.g. 16000)",
      },
      {
        name: "channels",
        valueRequired: true,
        valueName: "channels",
        description: "Channel count as a positive integer (e.g. 1)",
      },
      {
        name: "custom-model-id",
        valueRequired: true,
        valueName: "id",
        description: "Optional Reson8 custom model id",
      },
      {
        name: "include-timestamps",
        valueRequired: false,
        description: 'Include segment timestamps ("true"|"false" or flag for true)',
      },
      {
        name: "include-words",
        valueRequired: false,
        description: 'Include word-level details ("true"|"false" or flag for true)',
      },
      {
        name: "include-confidence",
        valueRequired: false,
        description: 'Include confidence values ("true"|"false" or flag for true)',
      },
    ],
    examples: [
      "reson8.prerecorded.transcribe --input ./audio.wav",
      "reson8.prerecorded.transcribe --input ./audio.raw --encoding pcm_s16le --sample-rate 16000 --channels 1",
      "reson8.prerecorded.transcribe --input ./audio.wav --format json",
      "reson8.prerecorded.transcribe --input ./audio.wav --print text",
    ],
  },
};

const normalizeEncoding = (
  value: string | undefined,
): Reson8PrerecordedQuery["encoding"] | undefined => {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (value !== "auto" && value !== "pcm_s16le") {
    throw new Error('--encoding must be one of: "auto", "pcm_s16le"');
  }
  return value;
};

const normalizePositiveInteger = (value: number | undefined, optionName: string) => {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${optionName} must be a positive integer`);
  }
  return value;
};

const readBooleanFlag = (
  options: ReturnType<typeof parseCliTokens>["options"],
  name: string,
): boolean | undefined => {
  const raw = options.get(name);
  if (typeof raw === "undefined") {
    return undefined;
  }
  if (Array.isArray(raw)) {
    throw new Error(`--${name} specified multiple times`);
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`--${name} must be true or false`);
};

const parsePrerecordedTranscribe = (
  args: string[],
): Reson8ParsedCommandByName["reson8.prerecorded.transcribe"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "reson8.prerecorded.transcribe");

  const output = readOutputOptions(parsed);

  return {
    name: "reson8.prerecorded.transcribe",
    args: {
      inputPath: readStringOption(parsed, "input", true)!,
      encoding: normalizeEncoding(readStringOption(parsed, "encoding")),
      sampleRate: normalizePositiveInteger(readIntegerOption(parsed, "sample-rate"), "sample-rate"),
      channels: normalizePositiveInteger(readIntegerOption(parsed, "channels"), "channels"),
      customModelId: readStringOption(parsed, "custom-model-id") ?? undefined,
      includeTimestamps: readBooleanFlag(parsed.options, "include-timestamps"),
      includeWords: readBooleanFlag(parsed.options, "include-words"),
      includeConfidence: readBooleanFlag(parsed.options, "include-confidence"),
    },
    output: output.print || parsed.options.has("format") ? output : { ...output, format: "text" },
    rawArgs: args,
  };
};

const RESON8_COMMAND_SPECS = {
  "reson8.prerecorded.transcribe": {
    name: "reson8.prerecorded.transcribe",
    help: HELP.prerecordedTranscribe,
    parse: parsePrerecordedTranscribe,
  },
} satisfies {
  [TCommandName in Reson8CommandName]: AutomationCommandSpec<
    TCommandName,
    Reson8ParsedCommandByName[TCommandName]["args"]
  > & {
    parse: (args: string[]) => Reson8ParsedCommandByName[TCommandName];
  };
};

export const RESON8_COMMAND_SPEC_LIST = RESON8_COMMAND_NAMES.map(
  (name) => RESON8_COMMAND_SPECS[name],
) as readonly (typeof RESON8_COMMAND_SPECS)[Reson8CommandName][];

const reson8CommandHandlers: Reson8CommandHandlers<RegisteredReson8BashCommandContext> = {
  "reson8.prerecorded.transcribe": async () => {
    throw new Error("reson8.prerecorded.transcribe is handled by a custom bash command.");
  },
};

const toPrerecordedQuery = (args: Reson8PrerecordedTranscribeArgs): Record<string, string> => {
  const query: Record<string, string> = {};

  if (args.encoding) {
    query.encoding = args.encoding;
  }
  if (typeof args.sampleRate === "number") {
    query.sample_rate = String(args.sampleRate);
  }
  if (typeof args.channels === "number") {
    query.channels = String(args.channels);
  }
  if (args.customModelId) {
    query.custom_model_id = args.customModelId;
  }
  if (typeof args.includeTimestamps === "boolean") {
    query.include_timestamps = String(args.includeTimestamps);
  }
  if (typeof args.includeWords === "boolean") {
    query.include_words = String(args.includeWords);
  }
  if (typeof args.includeConfidence === "boolean") {
    query.include_confidence = String(args.includeConfidence);
  }

  return query;
};

const createReson8TranscribeCommand = (
  reson8Context: RegisteredReson8BashCommandContext,
  commandCallsResult: BashAutomationCommandResult[],
) => {
  const spec = RESON8_COMMAND_SPECS["reson8.prerecorded.transcribe"];

  return defineCommand(spec.name, async (args, ctx) => {
    const parsed = parseCliTokens(args);

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
      const command = spec.parse(args);
      const inputPath = command.args.inputPath;
      const resolvedPath = ctx.fs.resolvePath(ctx.cwd, inputPath);
      const audio = await ctx.fs.readFileBuffer(resolvedPath);

      const data = await reson8Context.runtime.transcribePrerecorded({
        audio,
        query: toPrerecordedQuery(command.args),
      });

      const executionResult = normalizeExecutionResult({ data });
      const stdout = formatCommandStdout(command.output, executionResult);
      const outputForLog =
        executionResult.stdoutEncoding === "binary" ? "<binary>" : stdout.replace(/\n$/, "");

      const text = typeof data?.text === "string" ? data.text : "";
      const isEmptyText = text.trim().length === 0;
      const warning = isEmptyText ? ensureTrailingNewline("No transcription output.") : "";

      commandCallsResult.push({
        command: spec.name,
        output: outputForLog,
        exitCode: 0,
      });

      return {
        stdout: stdout || ensureTrailingNewline((data.text ?? "").trim()),
        stderr: warning,
        exitCode: 0,
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

export const createReson8BashCommands = (input: BashCommandFactoryInput) => {
  const reson8Context = input.context.reson8;
  if (!reson8Context) {
    return [];
  }

  return [
    ...createAutomationCommands(
      RESON8_COMMAND_SPEC_LIST,
      reson8CommandHandlers,
      reson8Context,
      input.commandCallsResult,
    ),
    createReson8TranscribeCommand(reson8Context, input.commandCallsResult),
  ];
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
        error: { message: string; code?: string };
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
    throw new NotConfiguredError(message ?? "Reson8 is not configured.");
  }

  if (message) {
    throw new Error(`Reson8 fragment returned ${response.status}: ${message}`);
  }

  throw new Error(`Reson8 fragment returned ${response.status} (${label})`);
};

const createReson8RouteCaller = (options: CreateRouteBackedReson8RuntimeOptions) => {
  return createRouteCaller<Reson8Fragment>({
    baseUrl: options.baseUrl,
    mountRoute: "/api/reson8",
    ...(options.headers ? { baseHeaders: options.headers } : {}),
    fetch: options.fetch,
  });
};

export const createRouteBackedReson8Runtime = (
  options: CreateRouteBackedReson8RuntimeOptions,
): Reson8BashRuntime => {
  const baseUrl = options.baseUrl.trim();
  if (!baseUrl) {
    throw new Error("Reson8 runtime requires a base URL");
  }

  const callRoute = createReson8RouteCaller({
    ...options,
    baseUrl,
  });

  return {
    transcribePrerecorded: async ({ audio, query }) => {
      const response = await callRoute("POST", "/speech-to-text/prerecorded", {
        body: audio,
        query,
        headers: {
          "content-type": "application/octet-stream",
        },
      });

      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data as Reson8PrerecordedTranscription;
      }

      return throwOnRouteError(response, "reson8.prerecorded.transcribe");
    },
  };
};

export const createReson8RouteBashRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): Reson8BashRuntime => {
  const reson8Do = env.RESON8.get(env.RESON8.idFromName(orgId));
  return createRouteBackedReson8Runtime({
    baseUrl: "https://reson8.do",
    fetch: reson8Do.fetch.bind(reson8Do),
  });
};

const RESON8_NOT_CONFIGURED = "Reson8 is not configured for this organisation.";

export const createUnavailableReson8BashRuntime = (
  message = RESON8_NOT_CONFIGURED,
): Reson8BashRuntime => ({
  transcribePrerecorded: async () => {
    throw new Error(message);
  },
});

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}
