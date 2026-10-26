import { calculateCost } from "@earendil-works/pi-ai/models";
import type {
  ModelsExtractModel,
  ModelsExtractThinkingLevel,
} from "@fragno-dev/backoffice-api/v0/models";
import type { JsonValue } from "@fragno-dev/backoffice-api/v0/shared/json";
import { z } from "zod";

import type { FetchFunction, Model, Usage } from "@earendil-works/pi-ai";

import { bytesToBase64 } from "@/lib/base64";

/** A workspace file the model reads: a PDF, whose pages it reads as text and images, or an image. */
export type PiExtractionFile = {
  filename: string;
  mimeType: "application/pdf" | "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
};

/** Resolved evidence: file bytes, never workspace paths, the answer's JSON Schema, and the model. */
export type PiExtractionRequest = {
  files: PiExtractionFile[];
  instructions: string;
  schema: Record<string, JsonValue>;
  model: ModelsExtractModel;
  thinkingLevel: ModelsExtractThinkingLevel;
};

/** Like pi-ai's results, a failure resolves rather than rejects, with any tokens it was charged. */
export type PiExtraction = { provider: "openai"; model: string; usage: Usage | null } & (
  | { stopReason: "stop"; output: JsonValue }
  | { stopReason: "error"; errorMessage: string }
);

const responseSchema = z.object({
  status: z.string(),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z
        .array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
            refusal: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }).nullish(),
    output_tokens: z.number().int().nonnegative(),
    output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative() }).nullish(),
    total_tokens: z.number().int().nonnegative(),
  }),
});

const errorResponseSchema = z.object({
  error: z.object({ message: z.string(), code: z.string().nullish(), type: z.string().nullish() }),
});

function fileInput(file: PiExtractionFile) {
  const dataUrl = `data:${file.mimeType};base64,${bytesToBase64(file.bytes)}`;
  return file.mimeType === "application/pdf"
    ? { type: "input_file", filename: file.filename, file_data: dataUrl }
    : { type: "input_image", detail: "auto", image_url: dataUrl };
}

/**
 * One Responses API call with the files inline and a strict JSON Schema answer. pi-ai's chat
 * content has no files, so the call is made here, priced with the model's catalog rates.
 */
export async function extractWithOpenAI({
  model,
  effort,
  apiKey,
  fetch,
  request,
}: {
  model: Model<"openai-responses">;
  /** OpenAI's name for the request's thinking level. */
  effort: string;
  apiKey: string;
  fetch: FetchFunction;
  request: PiExtractionRequest;
}): Promise<PiExtraction> {
  const result = { provider: "openai", model: model.id } as const;
  function failed(errorMessage: string, usage: Usage | null = null): PiExtraction {
    return { ...result, usage, stopReason: "error", errorMessage };
  }

  let response: Response;
  try {
    response = await fetch(`${model.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        store: false,
        reasoning: { effort },
        input: [
          {
            role: "user",
            content: [
              ...request.files.map(fileInput),
              { type: "input_text", text: request.instructions },
            ],
          },
        ],
        text: {
          format: { type: "json_schema", name: "answer", schema: request.schema, strict: true },
        },
      }),
    });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }

  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(body);
    if (!parsed.success) {
      return failed(`HTTP ${response.status}`);
    }
    const { code, type, message } = parsed.data.error;
    return failed(`${code ?? type ?? response.status}: ${message}`);
  }

  const parsed = responseSchema.parse(body);
  const cached = parsed.usage.input_tokens_details?.cached_tokens ?? 0;
  const usage: Usage = {
    // OpenAI counts cached tokens in input_tokens, which pi-ai keeps apart.
    input: parsed.usage.input_tokens - cached,
    output: parsed.usage.output_tokens,
    cacheRead: cached,
    cacheWrite: 0,
    reasoning: parsed.usage.output_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: parsed.usage.total_tokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  usage.cost = calculateCost(model, usage);

  if (parsed.status !== "completed") {
    return failed(
      `The response is ${parsed.status}${parsed.incomplete_details ? `: ${parsed.incomplete_details.reason}` : ""}.`,
      usage,
    );
  }
  const content = parsed.output.flatMap((item) =>
    item.type === "message" ? (item.content ?? []) : [],
  );
  const refusal = content.find((part) => part.type === "refusal");
  if (refusal) {
    return failed(`The model refused: ${refusal.refusal ?? ""}`, usage);
  }
  const text = content.find((part) => part.type === "output_text")?.text;
  if (text === undefined) {
    return failed("The model returned no answer.", usage);
  }
  // Strict structured output guarantees JSON that matches the request's schema.
  return { ...result, usage, stopReason: "stop", output: JSON.parse(text) as JsonValue };
}
