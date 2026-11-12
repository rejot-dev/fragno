import { artifactSourcePath } from "@/artifacts/kinds";
import { publicSiteHost, siteHostOrigin, siteUrl } from "@/artifacts/sites/site-host-names";
import { runtimeSiteHosts } from "@/artifacts/sites/site-hosts.server";
import { isSitePath } from "@/artifacts/sites/site-path";
import { siteStore } from "@/artifacts/sites/site-store.server";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { PAGE_SOURCES_GLOB } from "../pages/path";

const WORKSPACE = "/workspace/";
const WORKFLOW_SOURCES_GLOB = `${WORKSPACE}**/${artifactSourcePath("*", "workflow")}`;

/** What a site serves, as its build pointer says. */
export type SiteServing =
  | { kind: "unbuilt" }
  | { kind: "unreadable"; message: string }
  | { kind: "built"; public: boolean; url: string };

/** A file of the workspace, with when it last changed, in milliseconds since the epoch. */
type ArtifactSource = { sourcePath: string; editedAt: number };

/**
 * The pages, sites, and workflows of a scope's workspace, each with when its files last changed.
 * `sites` is null where the deployment serves no sites.
 */
export type ArtifactListing =
  | { kind: "no-workspace" }
  | {
      kind: "listed";
      pages: ArtifactSource[];
      sites: { sitePath: string; editedAt: number; serving: SiteServing }[] | null;
      workflows: ArtifactSource[];
    };

/** Every page, site, and workflow the execution can read, sorted by path. */
export async function listArtifacts({
  runtime,
  kernel,
  execution,
}: {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
}): Promise<ArtifactListing> {
  const { scope } = execution;
  // System scope has no workspace, and runtimes without Upload have none either.
  const state =
    scope.kind === "system"
      ? undefined
      : createCodemodeRouteBackedRuntimeContext({
          emitter: { kind: "caller" },
          runtime,
          kernel,
          execution,
        }).stateBackend;
  if (!state) {
    return { kind: "no-workspace" };
  }
  const sites = runtime.config.sites ? runtimeSiteHosts(runtime) : null;
  // Globs without a fixed folder read the workspace's tree once, which stat then looks paths up in.
  const [pageSources, workflowSources, siteCandidates, siteFiles] = await Promise.all([
    state.glob(PAGE_SOURCES_GLOB),
    state.glob(WORKFLOW_SOURCES_GLOB),
    sites ? state.glob(`${WORKSPACE}**/*.site`) : [],
    sites ? state.glob(`${WORKSPACE}**/*.site/**`) : [],
  ]);
  const [pages, workflows] = await Promise.all([
    sourcesEditedAt(state, pageSources),
    sourcesEditedAt(state, workflowSources),
  ]);
  if (!sites) {
    return { kind: "listed", pages, sites: null, workflows };
  }

  const sitePaths: string[] = [];
  for (const path of siteCandidates) {
    if (isSitePath(path) && (await state.stat(path))?.type === "directory") {
      sitePaths.push(path);
    }
  }
  // A built site was served at the scope's host, so asking for it claims none.
  let host: Promise<string> | undefined;
  const servedAt = async (sitePath: string, isPublic: boolean) => {
    const claimed = await (host ??= sites.hosts.hostFor(scope));
    return siteUrl(
      siteHostOrigin(isPublic ? publicSiteHost(claimed) : claimed, sites.domain),
      sitePath,
    );
  };
  return {
    kind: "listed",
    pages,
    workflows,
    sites: await Promise.all(
      sitePaths.map(async (sitePath) => {
        const files = siteFiles.filter((path) => path.startsWith(`${sitePath}/`));
        const read = await siteStore({
          siteStorage: runtime.siteStorage,
          state,
          scope,
          sitePath,
        }).readPointer();
        const serving: SiteServing =
          read.status === "none"
            ? { kind: "unbuilt" }
            : read.status === "unreadable"
              ? { kind: "unreadable", message: read.message }
              : {
                  kind: "built",
                  public: read.pointer.served.public,
                  url: await servedAt(sitePath, read.pointer.served.public),
                };
        return { sitePath, editedAt: await editedAt(state, [sitePath, ...files]), serving };
      }),
    ),
  };
}

async function sourcesEditedAt(
  state: BackofficeStateBackend,
  sourcePaths: readonly string[],
): Promise<ArtifactSource[]> {
  return await Promise.all(
    sourcePaths.map(async (sourcePath) => ({
      sourcePath,
      editedAt: await editedAt(state, [sourcePath]),
    })),
  );
}

/** When the newest of the paths last changed. */
async function editedAt(state: BackofficeStateBackend, paths: readonly string[]): Promise<number> {
  const stats = await Promise.all(paths.map((path) => state.stat(path)));
  return Math.max(...stats.map((stat) => stat?.mtime.getTime() ?? 0));
}
