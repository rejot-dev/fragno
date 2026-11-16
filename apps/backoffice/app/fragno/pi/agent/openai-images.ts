import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { z } from "zod";

import type {
  AssistantImages,
  ImageApi,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  Usage,
} from "@earendil-works/pi-ai";

/** Images API settings beyond the prompt, which pi-ai forwards to the adapter as request options. */
export type OpenAIImageOptions = {
  size: "auto" | "1024x1024" | "1536x1024" | "1024x1536";
  quality: "auto" | "low" | "medium" | "high" | "xhigh" | "max";
  outputFormat: "png" | "jpeg" | "webp";
};

const OPENAI_IMAGES_API = "openai-images";

const generationResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).min(1),
  output_format: z.enum(["png", "jpeg", "webp"]),
  usage: z.object({
    input_tokens_details: z.object({
      text_tokens: z.number().int().nonnegative(),
      image_tokens: z.number().int().nonnegative(),
    }),
    output_tokens: z.number().int().nonnegative(),
  }),
});

// USD per million reference image input tokens; pi-ai's model cost has one input rate, for text.
const IMAGE_INPUT_COST = 8;

const errorResponseSchema = z.object({
  error: z.object({ message: z.string(), code: z.string().nullish(), type: z.string().nullish() }),
});

/**
 * OpenAI's Images API, which pi-ai does not ship. It authenticates like pi-ai's OpenAI provider,
 * from `OPENAI_API_KEY`.
 */
export function openAIImagesProvider(): Provider {
  return createProvider({
    id: "openai-images",
    name: "OpenAI Images",
    auth: openaiProvider().auth,
    models: [
      {
        type: "image",
        id: "gpt-image-2.5-flare",
        name: "GPT Image 2.5 Flare",
        api: OPENAI_IMAGES_API,
        provider: "openai-images",
        baseUrl: "https://api.openai.com/v1",
        input: ["text", "image"],
        output: ["image"],
        // USD per million text input and image output tokens; image input costs IMAGE_INPUT_COST.
        cost: { input: 5, output: 30, cacheRead: 1.25, cacheWrite: 0 },
      },
    ],
    images: { [OPENAI_IMAGES_API]: { generateImages } },
  });
}

/**
 * `POST /v1/images/generations`, or `/v1/images/edits` with reference images; like pi-ai's
 * adapters, it resolves to an error result instead of rejecting.
 */
async function generateImages(
  model: ImageModel<ImageApi>,
  context: ImagesContext,
  options: ImagesOptions & OpenAIImageOptions,
): Promise<AssistantImages> {
  const result: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };
  function failed(errorMessage: string): AssistantImages {
    return { ...result, stopReason: options.signal?.aborted ? "aborted" : "error", errorMessage };
  }

  if (!options.apiKey) {
    return failed(`No API key for provider: ${model.provider}`);
  }
  const prompt = context.input.flatMap((part) => (part.type === "text" ? [part.text] : []));
  const images = context.input.flatMap((part) =>
    part.type === "image" ? [{ image_url: `data:${part.mimeType};base64,${part.data}` }] : [],
  );
  const settings = {
    model: model.id,
    prompt: prompt.join("\n"),
    n: 1,
    size: options.size,
    quality: options.quality,
    output_format: options.outputFormat,
  };
  // Called unbound: Workers reject a global fetch invoked as a method of another object.
  const send = options.fetch ?? fetch;
  try {
    const response = await send(
      `${model.baseUrl}/images/${images.length > 0 ? "edits" : "generations"}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(images.length > 0 ? { ...settings, images } : settings),
        signal: options.signal,
      },
    );
    const body: unknown = await response.json();
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(body);
      if (!parsed.success) {
        return failed(`HTTP ${response.status}`);
      }
      const { code, type, message } = parsed.data.error;
      return failed(`${code ?? type ?? response.status}: ${message}`);
    }
    const generation = generationResponseSchema.parse(body);
    return {
      ...result,
      output: generation.data.map((image) => ({
        type: "image",
        mimeType: `image/${generation.output_format}`,
        data: image.b64_json,
      })),
      usage: pricedUsage(model, generation.usage),
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

function pricedUsage(
  model: ImageModel<ImageApi>,
  usage: z.output<typeof generationResponseSchema>["usage"],
): Usage {
  const { text_tokens, image_tokens } = usage.input_tokens_details;
  const input = (model.cost.input * text_tokens + IMAGE_INPUT_COST * image_tokens) / 1_000_000;
  const output = (model.cost.output * usage.output_tokens) / 1_000_000;
  return {
    input: text_tokens + image_tokens,
    output: usage.output_tokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: text_tokens + image_tokens + usage.output_tokens,
    cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
  };
}
