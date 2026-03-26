import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { reson8FragmentDefinition } from "../definition";
import { missingAuthorizationError, resolveAuthorizationHeader } from "./shared";

export type Reson8BinaryBody = ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>;

export const reson8BinaryBodySchema = z.custom<Reson8BinaryBody>();

export const reson8PrerecordedQueryParameterNames = [
  "encoding",
  "sample_rate",
  "channels",
  "custom_model_id",
  "include_timestamps",
  "include_words",
  "include_confidence",
] as const;

export type Reson8PrerecordedQuery = {
  encoding?: "auto" | "pcm_s16le";
  sample_rate?: number;
  channels?: number;
  custom_model_id?: string;
  include_timestamps?: boolean;
  include_words?: boolean;
  include_confidence?: boolean;
};

export const reson8PrerecordedWordSchema = z.object({
  text: z.string(),
  start_ms: z.number().optional(),
  duration_ms: z.number().optional(),
  confidence: z.number().optional(),
});

export const reson8PrerecordedTranscriptionSchema = z.object({
  text: z.string(),
  start_ms: z.number().optional(),
  duration_ms: z.number().optional(),
  words: z.array(reson8PrerecordedWordSchema).optional(),
});

export type Reson8PrerecordedWord = z.infer<typeof reson8PrerecordedWordSchema>;
export type Reson8PrerecordedTranscription = z.infer<typeof reson8PrerecordedTranscriptionSchema>;

const parsePositiveInteger = (value: string, field: string): number => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }

  return parsed;
};

const parseBoolean = (value: string, field: string): boolean => {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${field} must be "true" or "false".`);
};

const parsePrerecordedQuery = (
  query: URLSearchParams,
): { success: true; data: Reson8PrerecordedQuery } | { success: false; message: string } => {
  try {
    const encodingValue = query.get("encoding");
    if (encodingValue && encodingValue !== "auto" && encodingValue !== "pcm_s16le") {
      throw new Error('encoding must be "auto" or "pcm_s16le".');
    }

    const encoding = encodingValue as "auto" | "pcm_s16le" | undefined;
    const sampleRate = query.get("sample_rate");
    const channels = query.get("channels");
    const includeTimestamps = query.get("include_timestamps");
    const includeWords = query.get("include_words");
    const includeConfidence = query.get("include_confidence");
    const customModelId = query.get("custom_model_id");

    return {
      success: true,
      data: {
        encoding,
        sample_rate: sampleRate ? parsePositiveInteger(sampleRate, "sample_rate") : undefined,
        channels: channels ? parsePositiveInteger(channels, "channels") : undefined,
        custom_model_id: customModelId ?? undefined,
        include_timestamps: includeTimestamps
          ? parseBoolean(includeTimestamps, "include_timestamps")
          : undefined,
        include_words: includeWords ? parseBoolean(includeWords, "include_words") : undefined,
        include_confidence: includeConfidence
          ? parseBoolean(includeConfidence, "include_confidence")
          : undefined,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

export const prerecordedRoutesFactory = defineRoutes(reson8FragmentDefinition).create(
  ({ defineRoute, deps, config }) => [
    defineRoute({
      method: "POST",
      path: "/speech-to-text/prerecorded",
      contentType: "application/octet-stream",
      inputSchema: reson8BinaryBodySchema,
      outputSchema: reson8PrerecordedTranscriptionSchema,
      queryParameters: reson8PrerecordedQueryParameterNames,
      errorCodes: [
        "INVALID_REQUEST",
        "UNAUTHORIZED",
        "PAYLOAD_TOO_LARGE",
        "INTERNAL_ERROR",
      ] as const,
      handler: async function (input, { json, error }) {
        const authorization = resolveAuthorizationHeader(input.headers, config);

        if (!authorization) {
          return error(missingAuthorizationError(), 401);
        }

        const parsedQuery = parsePrerecordedQuery(input.query);
        if (!parsedQuery.success) {
          return error(
            {
              code: "INVALID_REQUEST",
              message: parsedQuery.message,
            },
            400,
          );
        }

        const result = await deps.reson8.transcribePrerecorded({
          authorization,
          query: parsedQuery.data,
          body: input.bodyStream(),
        });

        return result.ok ? json(result.data) : error(result.error, { status: result.status });
      },
    }),
  ],
);
