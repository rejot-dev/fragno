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
import type { BlobsRuntime } from "./blobs-runtime";
import { readClassificationImages } from "./models-classification-images";
import { readExtractionFiles } from "./models-extraction-files";
import { assertModelsFilesReadable } from "./models-file-bytes";

export type ModelsRuntime = {
  classify(request: PiClassificationRequest): ReturnType<PiManagerCommands["classify"]>;
  generateImage(request: PiImageGenerationRequest): ReturnType<PiManagerCommands["generateImage"]>;
  extract(request: PiExtractionRequest): ReturnType<PiManagerCommands["extract"]>;
};

type ModelsToolContext = BackofficeToolContext<{
  models?: ModelsRuntime;
  state: BackofficeStateBackend | undefined;
  blobs?: BlobsRuntime;
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
  execute: async ({ state, images: files, questions }, context: ModelsToolContext) => {
    const models = requireModelsRuntime(context.runtimes.models);
    await assertModelsFilesReadable(context, files);
    const images = await readClassificationImages(
      { state: context.runtimes.state, blobs: context.runtimes.blobs },
      files,
    );
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
    { files, instructions, schema, model, thinkingLevel },
    context: ModelsToolContext,
  ) => {
    const models = requireModelsRuntime(context.runtimes.models);
    await assertModelsFilesReadable(context, files);
    return await models.extract({
      files: await readExtractionFiles(
        { state: context.runtimes.state, blobs: context.runtimes.blobs },
        files,
      ),
      instructions,
      schema,
      model,
      thinkingLevel,
    });
  },
});

export const modelsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "models",
  tools: [classifyTool, generateImageTool, extractTool],
  isAvailable: (context: ModelsToolContext) => !!context.runtimes.models,
});
