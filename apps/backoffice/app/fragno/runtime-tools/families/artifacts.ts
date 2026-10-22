import type { artifactPageBuildInputSchema } from "@fragno-dev/backoffice-api/v0/artifacts";
import type { PageLoad } from "@fragno-private/backoffice-ui/pages/definition";
import type { z } from "zod";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

/** Builds a page as its route does, with the same cache, so the caller sees what viewers see. */
export type ArtifactsRuntime = {
  loadPage(sourcePath: string): Promise<PageLoad>;
};

type ArtifactsToolContext = BackofficeToolContext<{ artifacts?: ArtifactsRuntime }>;

function requireArtifactsRuntime(context: ArtifactsToolContext): ArtifactsRuntime {
  if (!context.runtimes.artifacts) {
    throw new Error("Building artifacts is not available in this execution context.");
  }
  return context.runtimes.artifacts;
}

const buildPageTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("artifacts.pages.build"),
  namespace: "artifacts",
  name: "buildPage",
  getResource: ({ path }: z.output<typeof artifactPageBuildInputSchema>) => ({ path }),
  execute: async ({ path }, context: ArtifactsToolContext) => {
    const loaded = await requireArtifactsRuntime(context).loadPage(path);
    switch (loaded.kind) {
      case "missing":
        throw new Error(`${path} does not exist; write the page source first.`);
      case "failed":
        return { status: "failed" as const, path, message: loaded.message };
      case "ready":
        return { status: "built" as const, path };
    }
    throw new Error("Unsupported page load.");
  },
});

/** Runtime tool family for building the artifacts Backoffice opens. */
export const artifactsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "artifacts",
  tools: [buildPageTool],
  isAvailable: (context: ArtifactsToolContext) => Boolean(context.runtimes.artifacts),
});
