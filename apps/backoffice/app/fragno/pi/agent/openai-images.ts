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
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

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
        // Generations take only a prompt; reference images need the edits endpoint.
        input: ["text"],
        output: ["image"],
        // USD per million text input and image output tokens.
        cost: { input: 5, output: 30, cacheRead: 1.25, cacheWrite: 0 },
      },
    ],
    images: { [OPENAI_IMAGES_API]: { generateImages } },
  });
}

/** `POST /v1/images/generations`; like pi-ai's adapters, it resolves to an error result instead of rejecting. */
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

  if (context.input.some((part) => part.type === "image")) {
    return failed("Reference images are not supported.");
  }
  if (!options.apiKey) {
    return failed(`No API key for provider: ${model.provider}`);
  }
  // Called unbound: Workers reject a global fetch invoked as a method of another object.
  const send = options.fetch ?? fetch;
  try {
    const response = await send(`${model.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        prompt: context.input.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
        n: 1,
        size: options.size,
        quality: options.quality,
        output_format: options.outputFormat,
      }),
      signal: options.signal,
    });
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
  // Every input token is a text token: generations take no images.
  const input = (model.cost.input * usage.input_tokens) / 1_000_000;
  const output = (model.cost.output * usage.output_tokens) / 1_000_000;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage.input_tokens + usage.output_tokens,
    cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
  };
}
