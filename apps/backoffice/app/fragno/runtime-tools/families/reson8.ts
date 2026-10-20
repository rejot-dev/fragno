import { reson8TranscribeInputSchema } from "@fragno-dev/backoffice-api/v0/reson8";
import type { z } from "zod";

import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import {
  defineCliArgsParser,
  defineNoInputArgsParser,
  formatCommandStdout,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { Reson8Runtime } from "./reson8-runtime";

export type { Reson8Runtime } from "./reson8-runtime";

type Reson8ToolContext = BackofficeToolContext<{
  reson8?: Reson8Runtime;
  state?: BackofficeStateBackend;
}>;

const getReson8Runtime = (runtime: Reson8ToolContext["runtimes"]["reson8"]): Reson8Runtime => {
  if (!runtime) {
    throw new Error("Reson8 is not available in this execution context.");
  }
  return runtime;
};

type TranscribeInput = z.input<typeof reson8TranscribeInputSchema>;

const parsePrerecordedTranscribe = defineCliArgsParser<TranscribeInput>(
  "reson8.prerecorded.transcribe",
  {
    path: { option: "input", required: true },
    encoding: {
      transform: (value) => {
        if (value !== "auto" && value !== "pcm_s16le") {
          throw new Error('--encoding must be one of: "auto", "pcm_s16le"');
        }
        return value;
      },
    },
    sampleRate: { kind: "positiveInteger" },
    channels: { kind: "positiveInteger" },
    customModelId: {},
    includeTimestamps: { kind: "boolean" },
    includeWords: { kind: "boolean" },
    includeConfidence: { kind: "boolean" },
  },
);

/** Reson8 takes snake_case query strings; unset options keep the service defaults. */
function toPrerecordedQuery(args: Omit<TranscribeInput, "path">): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of [
    ["encoding", args.encoding],
    ["sample_rate", args.sampleRate],
    ["channels", args.channels],
    ["custom_model_id", args.customModelId],
    ["include_timestamps", args.includeTimestamps],
    ["include_words", args.includeWords],
    ["include_confidence", args.includeConfidence],
  ] as const) {
    if (value !== undefined) {
      query[key] = String(value);
    }
  }
  return query;
}

const transcribePrerecordedTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("reson8.prerecorded.transcribe"),
  namespace: "reson8",
  name: "transcribePrerecorded",
  execute: async ({ path, ...options }, context: Reson8ToolContext) => {
    if (!context.runtimes.state) {
      throw new Error("Reson8 transcription reads workspace files, which this context lacks.");
    }
    return await getReson8Runtime(context.runtimes.reson8).transcribePrerecorded({
      audio: await context.runtimes.state.readFileBytes(path),
      query: toPrerecordedQuery(options),
    });
  },
  adapters: {
    bash: {
      command: "reson8.prerecorded.transcribe",
      help: {
        summary: "Transcribe a prerecorded audio file with Reson8.",
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
            description: "Sample rate of raw PCM audio (e.g. 16000)",
          },
          {
            name: "channels",
            valueRequired: true,
            valueName: "channels",
            description: "Channel count of raw PCM audio (e.g. 1)",
          },
          {
            name: "custom-model-id",
            valueRequired: true,
            valueName: "id",
            description: "Reson8 custom model id",
          },
          {
            name: "include-timestamps",
            valueRequired: false,
            description: "Include segment timestamps",
          },
          {
            name: "include-words",
            valueRequired: false,
            description: "Include word-level details",
          },
          {
            name: "include-confidence",
            valueRequired: false,
            description: "Include confidence values",
          },
        ],
        examples: [
          "reson8.prerecorded.transcribe --input ./audio.wav",
          "reson8.prerecorded.transcribe --input ./audio.raw --encoding pcm_s16le --sample-rate 16000 --channels 1",
          "reson8.prerecorded.transcribe --input ./audio.wav --format json",
        ],
      },
      parse: parsePrerecordedTranscribe,
      outputOptions: (args) => {
        const parsed = parseCliTokens(args);
        const output = readOutputOptions(parsed);
        return output.print || parsed.options.has("format")
          ? output
          : { ...output, format: "text" };
      },
      execute: async ({ input, context, commandOutput, shell }) => {
        // Relative paths resolve against the shell's working directory.
        const { path, ...options } = input;
        if (!shell.fs.readFileBuffer) {
          throw new Error(
            "reson8.prerecorded.transcribe requires a filesystem that supports binary reads",
          );
        }
        const data = await getReson8Runtime(context.runtimes.reson8).transcribePrerecorded({
          audio: await shell.fs.readFileBuffer(shell.fs.resolvePath(shell.cwd, path)),
          query: toPrerecordedQuery(options),
        });
        // Text output is the transcript itself; --format json and --print format the result.
        const text = data.text.trim();
        return {
          data,
          stdout: formatCommandStdout(commandOutput, { data }) || (text ? `${text}\n` : ""),
          stderr: text ? "" : "No transcription output.\n",
        };
      },
    },
  },
});

const createRealtimeTokenTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("reson8.realtime.token"),
  namespace: "reson8",
  name: "createRealtimeToken",
  execute: async (_input, context: Reson8ToolContext) =>
    await getReson8Runtime(context.runtimes.reson8).createRealtimeToken(),
  adapters: {
    bash: {
      command: "reson8.realtime.token",
      help: {
        summary: "Mint a short-lived token for streaming audio to Reson8 directly.",
        options: [],
        examples: ["reson8.realtime.token --format json", "reson8.realtime.token --print url"],
      },
      parse: defineNoInputArgsParser("reson8.realtime.token"),
    },
  },
});

export const reson8ToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "reson8",
  tools: [transcribePrerecordedTool, createRealtimeTokenTool],
  isAvailable: (context: Reson8ToolContext) => !!context.runtimes.reson8,
});
