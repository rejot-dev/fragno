import type { PiManagerObject } from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { PiClassificationRequest } from "@/fragno/pi/agent/pi-models";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type ModelsRuntime = {
  classify(request: PiClassificationRequest): ReturnType<PiManagerObject["classify"]>;
};

type ModelsToolContext = BackofficeToolContext<{ models?: ModelsRuntime }>;

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
      throw new BackofficeOperationError(
        "invalid_request",
        "MODELS_BILLING_OWNER_REQUIRED: classifying outside an organization requires a billing organization.",
      );
    }
    return { answers: classified.answers };
  },
});

export const modelsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "models",
  tools: [classifyTool],
  isAvailable: (context: ModelsToolContext) => !!context.runtimes.models,
});
