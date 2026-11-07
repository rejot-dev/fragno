import type {
  ArtifactSiteDataStatus,
  artifactPageBuildInputSchema,
  artifactSiteBuildInputSchema,
} from "@fragno-dev/backoffice-api/v0/artifacts";
import type { PageLoad } from "@fragno-private/backoffice-ui/pages/definition";
import type { z } from "zod";

import type { SiteBuildOutcome } from "@/artifacts/sites/build.server";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type ArtifactsRuntime = {
  /** Builds a page as its route does, with the same cache, so the caller sees what viewers see. */
  loadPage(sourcePath: string): Promise<PageLoad>;
  buildSite(sitePath: string): Promise<SiteBuildOutcome>;
  /** Reports the copy of the scope's automation data its sites read. */
  siteDataStatus(): Promise<ArtifactSiteDataStatus>;
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

const buildSiteTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("artifacts.sites.build"),
  namespace: "artifacts",
  name: "buildSite",
  getResource: ({ path }: z.output<typeof artifactSiteBuildInputSchema>) => ({ path }),
  execute: async ({ path }, context: ArtifactsToolContext) => {
    const built = await requireArtifactsRuntime(context).buildSite(path);
    switch (built.kind) {
      case "rejected":
        throw new Error(built.message);
      case "failed":
        return { status: "failed" as const, path, message: built.message };
      case "built":
        return { status: "built" as const, path };
    }
    throw new Error("Unsupported site build.");
  },
});

const siteDataStatusTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("artifacts.sites.dataStatus"),
  namespace: "artifacts",
  name: "siteDataStatus",
  getResource: () => ({}),
  execute: async (_input, context: ArtifactsToolContext) =>
    await requireArtifactsRuntime(context).siteDataStatus(),
});

/** Runtime tool family for building the artifacts Backoffice opens. */
export const artifactsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "artifacts",
  tools: [buildPageTool, buildSiteTool, siteDataStatusTool],
  isAvailable: (context: ArtifactsToolContext) => Boolean(context.runtimes.artifacts),
});
