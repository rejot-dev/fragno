import type { PiManagerObject } from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import type {
  PiClassificationRequest,
  PiImageGenerationRequest,
} from "@/fragno/pi/agent/pi-models";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type ModelsRuntime = {
  classify(request: PiClassificationRequest): ReturnType<PiManagerObject["classify"]>;
  generateImage(request: PiImageGenerationRequest): ReturnType<PiManagerObject["generateImage"]>;
};

type ModelsToolContext = BackofficeToolContext<{
  models?: ModelsRuntime;
  state: BackofficeStateBackend | undefined;
}>;

function billingOwnerRequired(work: string): BackofficeOperationError {
  return new BackofficeOperationError(
    "invalid_request",
    `MODELS_BILLING_OWNER_REQUIRED: ${work} outside an organization requires a billing organization.`,
  );
}

const OUTPUT_FORMAT_BY_EXTENSION = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  webp: "webp",
} as const satisfies Record<string, PiImageGenerationRequest["outputFormat"]>;

/** The input schema admits only these extensions. */
function outputFormatOf(path: string): PiImageGenerationRequest["outputFormat"] {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return OUTPUT_FORMAT_BY_EXTENSION[extension as keyof typeof OUTPUT_FORMAT_BY_EXTENSION];
}

function requireModelsRuntime(runtime: ModelsToolContext["runtimes"]["models"]): ModelsRuntime {
  if (!runtime) {
    throw new Error("Models runtime is not available in this execution context");
  }
  return runtime;
}

const classifyTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("models.classify"),
  namespace: "models",
  name: "classify",
  execute: async (input, context: ModelsToolContext) => {
    const classified = await requireModelsRuntime(context.runtimes.models).classify(input);
    if (classified.type === "billing-owner-required") {
      throw billingOwnerRequired("classifying");
    }
    return { answers: classified.answers };
  },
});

const generateImageTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("models.generateImage"),
  namespace: "models",
  name: "generateImage",
  getResource: ({ out }) => ({ path: out }),
  execute: async ({ prompt, out, size, quality }, context: ModelsToolContext) => {
    const state = context.runtimes.state;
    if (!state) {
      throw new Error("Generating an image requires the workspace filesystem.");
    }
    const generated = await requireModelsRuntime(context.runtimes.models).generateImage({
      prompt,
      size,
      quality,
      outputFormat: outputFormatOf(out),
    });
    if (generated.type === "billing-owner-required") {
      throw billingOwnerRequired("generating an image");
    }
    await state.writeFileBytes(out, generated.bytes);
    return { path: out };
  },
});

export const modelsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "models",
  tools: [classifyTool, generateImageTool],
  isAvailable: (context: ModelsToolContext) => !!context.runtimes.models,
});
