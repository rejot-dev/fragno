import {
  createModels,
  getSupportedThinkingLevels,
  type Models,
  type ModelsImagesOptions,
  type MutableModels,
} from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  MODELS_EXTRACT_MODELS,
  type ModelsExtractModel,
} from "@fragno-dev/backoffice-api/v0/models";

import type {
  AssistantImages,
  ClassifierContext,
  ClassifierResult,
  FetchFunction,
  Model,
} from "@earendil-works/pi-ai";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";

import {
  extractWithOpenAI,
  type PiExtraction,
  type PiExtractionRequest,
} from "./openai-extraction";
import { openAIImagesProvider, type OpenAIImageOptions } from "./openai-images";
import type { PiAvailableModel } from "./pi-agent-contract";

/** Models intentionally offered by Backoffice, in default-selection order. */
const PI_SUPPORTED_MODELS = [
  { provider: "openai", modelId: "gpt-6-luna", label: "GPT-6 Luna" },
  { provider: "openai", modelId: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { provider: "anthropic", modelId: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { provider: "google", modelId: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
] as const;

/** Builds durable Pi providers from Worker or Node credentials without filesystem auth lookup. */
export function createPiModels(
  env: Pick<BackofficeRuntimeEnv, "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY">,
): Models {
  const keys: Record<string, string | undefined> = {
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: env.GEMINI_API_KEY,
  };
  const models = createModels({
    authContext: {
      env: async (name) => keys[name],
      fileExists: async () => false,
    },
  });
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(googleProvider());
  return models;
}

/** Answers typed questions about state and images; resolves to an error result instead of rejecting. */
export type PiClassifier = (context: PiClassificationRequest) => Promise<ClassifierResult>;

/** Resolved evidence: image bytes, never workspace paths, and the questions asked about it. */
export type PiClassificationRequest = Required<
  Pick<ClassifierContext, "state" | "images" | "questions">
>;

/** Classifies with OpenAI's Decisions API, which requires an OpenAI API key. */
export function createPiClassifier(
  env: Pick<BackofficeRuntimeEnv, "OPENAI_API_KEY">,
  fetch: FetchFunction,
): PiClassifier | null {
  if (!env.OPENAI_API_KEY) {
    return null;
  }
  const models = createOpenAIModels(env.OPENAI_API_KEY);
  models.setProvider(openaiProvider());
  const model = models.getModelOfType("classifier", "openai", "gpt-6-luna");
  if (!model) {
    throw new Error("pi-ai no longer lists OpenAI's gpt-6-luna classifier.");
  }
  return async (context) => await models.classify(model, context, { fetch });
}

/** Generates an image from a prompt; resolves to an error result instead of rejecting. */
export type PiImageGenerator = (request: PiImageGenerationRequest) => Promise<AssistantImages>;

/** A caller's image: the prompt and the Images API settings it is rendered with. */
export type PiImageGenerationRequest = OpenAIImageOptions & { prompt: string };

/** Generates images with OpenAI's GPT Image 2.5 Flare, which requires an OpenAI API key. */
export function createPiImageGenerator(
  env: Pick<BackofficeRuntimeEnv, "OPENAI_API_KEY">,
  fetch: FetchFunction,
): PiImageGenerator | null {
  if (!env.OPENAI_API_KEY) {
    return null;
  }
  const models = createOpenAIModels(env.OPENAI_API_KEY);
  const provider = openAIImagesProvider();
  models.setProvider(provider);
  const model = models.getModelOfType("image", provider.id, "gpt-image-2.5-flare");
  if (!model) {
    throw new Error("The OpenAI Images provider no longer lists gpt-image-2.5-flare.");
  }
  return async ({ prompt, ...settings }) => {
    const options: ModelsImagesOptions & OpenAIImageOptions = { ...settings, fetch };
    return await models.generateImages(model, { input: [{ type: "text", text: prompt }] }, options);
  };
}

/** Reads files into an answer that matches a JSON Schema; resolves to an error result instead of rejecting. */
export type PiExtractor = (request: PiExtractionRequest) => Promise<PiExtraction>;

/** Extracts with an OpenAI Responses model, which requires an OpenAI API key. */
export function createPiExtractor(
  env: Pick<BackofficeRuntimeEnv, "OPENAI_API_KEY">,
  fetch: FetchFunction,
): PiExtractor | null {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  const catalog = createOpenAIModels(apiKey);
  catalog.setProvider(openaiProvider());
  // Resolved up front, so a pi-ai release that drops a model fails here rather than mid-call.
  const models = Object.fromEntries(
    MODELS_EXTRACT_MODELS.map((name) => {
      const [provider, modelId] = name.split("/") as [string, string];
      const model = catalog.getModelOfType("chat", provider, modelId);
      if (model?.api !== "openai-responses") {
        throw new Error(`pi-ai no longer lists ${name} on OpenAI's Responses API.`);
      }
      return [name, model as Model<"openai-responses">];
    }),
  ) as Record<ModelsExtractModel, Model<"openai-responses">>;
  return async (request) => {
    const model = models[request.model];
    // OpenAI may name a level differently from pi.
    const effort = model.thinkingLevelMap?.[request.thinkingLevel] ?? request.thinkingLevel;
    return await extractWithOpenAI({ model, effort, apiKey, fetch, request });
  };
}

function createOpenAIModels(apiKey: string): MutableModels {
  return createModels({
    authContext: {
      env: async (name) => (name === "OPENAI_API_KEY" ? apiKey : undefined),
      fileExists: async () => false,
    },
  });
}

/** Lists supported chat models whose provider credentials are available to durable Pi. */
export async function listAvailablePiModels(models: Models): Promise<readonly PiAvailableModel[]> {
  const credentialAvailableModels = await models.getAvailable();
  return PI_SUPPORTED_MODELS.flatMap((supportedModel) => {
    const available = credentialAvailableModels.find(
      (model) => model.provider === supportedModel.provider && model.id === supportedModel.modelId,
    );
    return available
      ? [
          {
            ...supportedModel,
            contextWindow: available.contextWindow,
            thinkingLevels: getSupportedThinkingLevels(available),
          },
        ]
      : [];
  });
}
