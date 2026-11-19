import type {
  ArtifactSiteDataStatus,
  ArtifactSiteLink,
  ArtifactSiteLinkInput,
  ArtifactSiteResponse,
  ArtifactSiteVisitedLogEntry,
  ArtifactSiteVisitEvent,
  artifactPageBuildInputSchema,
  artifactSiteBuildInputSchema,
  artifactSiteLinkInputSchema,
  artifactSiteLogsInputSchema,
  artifactSiteRequestInputSchema,
} from "@fragno-dev/backoffice-api/v0/artifacts";
import type { PageLoad } from "@fragno-private/backoffice-ui/pages/definition";
import type { z } from "zod";

import type { SiteBuildResult } from "@/artifacts/sites/build.server";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type ArtifactsRuntime = {
  /** Builds a page as its route does, with the same cache, so the caller sees what viewers see. */
  loadPage(sourcePath: string): Promise<PageLoad>;
  buildSite(sitePath: string): Promise<SiteBuildResult>;
  /** Reports the copy of the scope's automation data its sites read. */
  siteDataStatus(): Promise<ArtifactSiteDataStatus>;
  siteLogs(
    input: z.output<typeof artifactSiteLogsInputSchema>,
  ): Promise<{ entries: ArtifactSiteVisitedLogEntry[]; events: ArtifactSiteVisitEvent[] }>;
  requestSite(
    input: z.output<typeof artifactSiteRequestInputSchema>,
  ): Promise<ArtifactSiteResponse>;
  createSiteLink(input: ArtifactSiteLinkInput): Promise<ArtifactSiteLink>;
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
  activity: { label: "Build page", target: (input) => input.path },
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
  activity: { label: "Build site", target: (input) => input.path },
  getResource: ({ path }: z.output<typeof artifactSiteBuildInputSchema>) => ({ path }),
  execute: async ({ path }, context: ArtifactsToolContext) => {
    const built = await requireArtifactsRuntime(context).buildSite(path);
    switch (built.kind) {
      case "rejected":
        throw new Error(built.message);
      case "failed":
        return { status: "failed" as const, path, message: built.message };
      case "built":
        return { status: "built" as const, path, url: built.url, firesEvents: built.fires };
    }
    throw new Error("Unsupported site build.");
  },
});

const siteDataStatusTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("artifacts.sites.dataStatus"),
  namespace: "artifacts",
  name: "siteDataStatus",
  activity: { label: "Check site data", target: () => null },
  getResource: () => ({}),
  execute: async (_input, context: ArtifactsToolContext) =>
    await requireArtifactsRuntime(context).siteDataStatus(),
});

const siteLogsTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("artifacts.sites.logs"),
  namespace: "artifacts",
  name: "siteLogs",
  activity: { label: "Read site logs", target: (input) => input.path },
  getResource: ({ path }: z.output<typeof artifactSiteLogsInputSchema>) => ({ path }),
  execute: async (input, context: ArtifactsToolContext) =>
    await requireArtifactsRuntime(context).siteLogs(input),
});

const requestSiteTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("artifacts.sites.request"),
  namespace: "artifacts",
  name: "requestSite",
  activity: {
    label: "Request site",
    target: (input) => `${input.method ?? "GET"} ${input.url ?? "/"} on ${input.path}`,
  },
  getResource: ({ path }: z.output<typeof artifactSiteRequestInputSchema>) => ({ path }),
  execute: async (input, context: ArtifactsToolContext) =>
    await requireArtifactsRuntime(context).requestSite(input),
});

const createSiteLinkTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("artifacts.sites.link"),
  namespace: "artifacts",
  name: "createSiteLink",
  activity: { label: "Link site", target: (input) => `${input.url ?? "/"} on ${input.path}` },
  getResource: ({ path }: z.output<typeof artifactSiteLinkInputSchema>) => ({ path }),
  execute: async (input, context: ArtifactsToolContext) =>
    await requireArtifactsRuntime(context).createSiteLink(input),
});

/** Runtime tool family for building the artifacts Backoffice opens. */
export const artifactsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "artifacts",
  tools: [
    buildPageTool,
    buildSiteTool,
    siteDataStatusTool,
    siteLogsTool,
    requestSiteTool,
    createSiteLinkTool,
  ],
  isAvailable: (context: ArtifactsToolContext) => Boolean(context.runtimes.artifacts),
});
