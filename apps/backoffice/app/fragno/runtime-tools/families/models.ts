import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

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
import { readClassificationImages } from "./models-classification-images";

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
  execute: async ({ state, images: paths, questions }, context: ModelsToolContext) => {
    const models = requireModelsRuntime(context.runtimes.models);
    let images: PiClassificationRequest["images"] = [];
    if (paths.length > 0) {
      await context.kernel.assertAuthorizedAll({
        execution: context.execution,
        requirements: paths.map((path) => ({
          operation: BACKOFFICE_PERMISSION.upload.read,
          resource: { path },
        })),
      });
      if (!context.runtimes.state) {
        throw new Error("Classifying images requires the workspace filesystem.");
      }
      images = await readClassificationImages(context.runtimes.state, paths);
    }
    const classified = await models.classify({ state, images, questions });
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
