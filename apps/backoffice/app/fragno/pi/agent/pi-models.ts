import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";

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
