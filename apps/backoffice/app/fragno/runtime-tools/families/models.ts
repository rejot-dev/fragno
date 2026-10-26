import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import type { PiManagerCommands } from "@/backoffice-runtime/object-registry";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import type { PiExtractionRequest } from "@/fragno/pi/agent/openai-extraction";
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
import { readExtractionFiles } from "./models-extraction-files";

export type ModelsRuntime = {
  classify(request: PiClassificationRequest): ReturnType<PiManagerCommands["classify"]>;
  generateImage(request: PiImageGenerationRequest): ReturnType<PiManagerCommands["generateImage"]>;
  extract(request: PiExtractionRequest): ReturnType<PiManagerCommands["extract"]>;
};

type ModelsToolContext = BackofficeToolContext<{
  models?: ModelsRuntime;
  state: BackofficeStateBackend | undefined;
}>;

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
    const { answers } = await models.classify({ state, images, questions });
    return { answers };
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
    const { bytes } = await requireModelsRuntime(context.runtimes.models).generateImage({
      prompt,
      size,
      quality,
      outputFormat: outputFormatOf(out),
    });
    await state.writeFileBytes(out, bytes);
    return { path: out };
  },
});

const extractTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("models.extract"),
  namespace: "models",
  name: "extract",
  execute: async (
    { files: paths, instructions, schema, model, thinkingLevel },
    context: ModelsToolContext,
  ) => {
    const models = requireModelsRuntime(context.runtimes.models);
    await context.kernel.assertAuthorizedAll({
      execution: context.execution,
      requirements: paths.map((path) => ({
        operation: BACKOFFICE_PERMISSION.upload.read,
        resource: { path },
      })),
    });
    if (!context.runtimes.state) {
      throw new Error("Extracting from files requires the workspace filesystem.");
    }
    const files = await readExtractionFiles(context.runtimes.state, paths);
    return await models.extract({ files, instructions, schema, model, thinkingLevel });
  },
});

export const modelsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "models",
  tools: [classifyTool, generateImageTool, extractTool],
  isAvailable: (context: ModelsToolContext) => !!context.runtimes.models,
});
