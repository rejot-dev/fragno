import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import { createRegistry, type HarnessOptions } from "@earendil-works/pi-durable";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import type { PiAvailableModel } from "@/fragno/pi-manager/pi-agent-contract";
import { PI_SUPPORTED_MODELS } from "@/fragno/pi/pi-shared";

/** Builds durable Pi providers from Worker or Node credentials without filesystem auth lookup. */
export function createPiDurableModels(
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
export async function listSupportedPiDurableModels(
  models: Models,
): Promise<readonly PiAvailableModel[]> {
  const credentialAvailableModels = await models.getAvailable();
  return PI_SUPPORTED_MODELS.flatMap((supportedModel) => {
    const available = credentialAvailableModels.some(
      (model) => model.provider === supportedModel.provider && model.id === supportedModel.modelId,
    );
    return available ? [supportedModel] : [];
  });
}

/** Builds the durable Pi harness from the same credential-aware catalog exposed by the manager. */
export function createPiDurableHarnessOptions(
  env: Pick<BackofficeRuntimeEnv, "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY">,
): HarnessOptions {
  return { models: createPiDurableModels(env), registry: createRegistry() };
}
