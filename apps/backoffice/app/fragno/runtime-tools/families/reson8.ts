import { z } from "zod";

import { reson8PrerecordedTranscriptionSchema } from "@fragno-dev/reson8-fragment";

import {
  defineCliArgsParser,
  ensureTrailingNewline,
  formatCommandStdout,
  normalizeExecutionResult,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/runtime-tools/bash-cli";
import type {
  Reson8PrerecordedTranscribeArgs,
  Reson8Runtime,
} from "@/fragno/runtime-tools/families/reson8-runtime";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type Reson8PrerecordedTranscriptionInput = Omit<
  Partial<Reson8PrerecordedTranscribeArgs>,
  "inputPath"
> & {
  audio?: ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>;
};

type Reson8ToolContext = BackofficeToolContext<{ reson8?: Reson8Runtime }>;

const nonEmptyString = z.string().trim().min(1);
const encodingSchema = z.enum(["auto", "pcm_s16le"]).optional();
const positiveIntegerSchema = z.number().int().positive().optional();

const transcribeInputSchema = z.object({
  audio: z.unknown().optional(),
  encoding: encodingSchema,
  sampleRate: positiveIntegerSchema,
  channels: positiveIntegerSchema,
  customModelId: nonEmptyString.optional(),
  includeTimestamps: z.boolean().optional(),
  includeWords: z.boolean().optional(),
  includeConfidence: z.boolean().optional(),
});

const getReson8Runtime = (runtime: Reson8ToolContext["runtimes"]["reson8"]): Reson8Runtime => {
  if (!runtime) {
    throw new Error("Reson8 runtime is not available in this execution context");
  }
  return runtime;
};

const isByteArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);

const normalizeAudioInput = (
  audio: unknown,
): ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array> => {
  if (audio instanceof ArrayBuffer || ArrayBuffer.isView(audio)) {
    return audio;
  }

  if (isByteArray(audio)) {
    return new Uint8Array(audio);
  }

  if (typeof Blob !== "undefined" && audio instanceof Blob) {
    return audio;
  }

  if (typeof ReadableStream !== "undefined" && audio instanceof ReadableStream) {
    return audio as ReadableStream<Uint8Array>;
  }

  throw new Error(
    "reson8.transcribePrerecorded requires audio as bytes, an ArrayBuffer, a typed array, a Blob, or a ReadableStream",
  );
};

const normalizeEncoding = (value: string | undefined) => {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (value !== "auto" && value !== "pcm_s16le") {
    throw new Error('--encoding must be one of: "auto", "pcm_s16le"');
  }
  return value;
};

const parsePrerecordedTranscribe = defineCliArgsParser<Reson8PrerecordedTranscribeArgs>(
  "reson8.prerecorded.transcribe",
  {
    inputPath: { option: "input", required: true },
    encoding: { transform: (value) => normalizeEncoding(value) },
    sampleRate: { kind: "positiveInteger" },
    channels: { kind: "positiveInteger" },
    customModelId: {},
    includeTimestamps: { kind: "boolean" },
    includeWords: { kind: "boolean" },
    includeConfidence: { kind: "boolean" },
  },
);

const toPrerecordedQuery = (
  args: Partial<Reson8PrerecordedTranscribeArgs>,
): Record<string, string> => {
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

const transcribePrerecordedTool = defineBackofficeRuntimeTool({
  id: "reson8.prerecorded.transcribe",
  namespace: "reson8",
  name: "transcribePrerecorded",
  description: "Transcribe a prerecorded audio file via Reson8.",
  inputSchema: transcribeInputSchema,
  outputSchema: reson8PrerecordedTranscriptionSchema,
  execute: async (input, context: Reson8ToolContext) => {
    if (!input.audio) {
      throw new Error("reson8.transcribePrerecorded requires audio input");
    }

    return getReson8Runtime(context.runtimes.reson8).transcribePrerecorded({
      audio: normalizeAudioInput(input.audio),
      query: toPrerecordedQuery(input),
    });
  },
  adapters: {
    bash: {
      command: "reson8.prerecorded.transcribe",
      help: {
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
      parse: parsePrerecordedTranscribe,
      outputOptions: (args) => {
        const parsed = parseCliTokens(args);
        const output = readOutputOptions(parsed);
        return output.print || parsed.options.has("format")
          ? output
          : { ...output, format: "text" };
      },
      execute: async ({ input, context, commandOutput, shell }) => {
        const bashInput = input as Partial<Reson8PrerecordedTranscribeArgs>;
        if (!shell.fs.readFileBuffer) {
          throw new Error(
            "reson8.prerecorded.transcribe requires a filesystem that supports binary reads",
          );
        }
        if (!bashInput.inputPath) {
          throw new Error("reson8.prerecorded.transcribe requires --input");
        }
        const resolvedPath = shell.fs.resolvePath(shell.cwd, bashInput.inputPath);
        const data = await getReson8Runtime(context.runtimes.reson8).transcribePrerecorded({
          audio: await shell.fs.readFileBuffer(resolvedPath),
          query: toPrerecordedQuery(bashInput),
        });
        const result = normalizeExecutionResult({ data });
        const stdout = formatCommandStdout(commandOutput, result);
        const text =
          typeof (data as { text?: unknown })?.text === "string"
            ? (data as { text: string }).text
            : "";
        const warning =
          text.trim().length === 0 ? ensureTrailingNewline("No transcription output.") : "";
        return { data, stdout: stdout || ensureTrailingNewline(text.trim()), stderr: warning };
      },
    },
  },
});

export const reson8RuntimeTools = [transcribePrerecordedTool] as const;

export const reson8ToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "reson8",
  tools: reson8RuntimeTools,
  isAvailable: (context: Reson8ToolContext) => !!context.runtimes.reson8,
});

export type { Reson8Runtime, Reson8PrerecordedTranscribeArgs };
