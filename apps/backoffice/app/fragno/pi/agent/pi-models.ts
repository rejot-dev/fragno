import {
  createModels,
  type Models,
  type ModelsImagesOptions,
  type MutableModels,
} from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import type {
  AssistantImages,
  ClassifierContext,
  ClassifierResult,
  FetchFunction,
} from "@earendil-works/pi-ai";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";

import { openAIImagesProvider, type OpenAIImageOptions } from "./openai-images";
import type { PiAvailableModel } from "./pi-agent-contract";

/** Models intentionally offered by Backoffice, in default-selection order. */
const PI_SUPPORTED_MODELS = [
  { provider: "openai", modelId: "gpt-6-luna", label: "GPT-6 Luna" },
  { provider: "openai", modelId: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { provider: "anthropic", modelId: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { provider: "google", modelId: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
] as const;

export const PI_THINKING_LEVEL = "low";

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

/** Answers typed questions about JSON state; resolves to an error result instead of rejecting. */
export type PiClassifier = (context: ClassifierContext) => Promise<ClassifierResult>;

/** A caller's classification: the evidence and the questions asked about it. */
export type PiClassificationRequest = Pick<ClassifierContext, "state" | "questions">;

/** Classifies with OpenAI's Decisions API, which requires an OpenAI API key. */
export function createPiClassifier(
  env: Pick<BackofficeRuntimeEnv, "OPENAI_API_KEY">,
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
  return async (context) => await models.classify(model, context);
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
    return available ? [{ ...supportedModel, contextWindow: available.contextWindow }] : [];
  });
}
