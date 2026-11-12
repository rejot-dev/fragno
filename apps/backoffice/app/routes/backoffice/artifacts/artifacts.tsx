import {
  ArtifactsView,
  type ArtifactSite,
} from "@fragno-private/design-system/artifacts/artifacts-view";
import { formatRelativeTime } from "@fragno-private/design-system/data/relative-time";
import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import { BackofficeTabHeader } from "@fragno-private/design-system/navigation/tab-header";

import { artifactName } from "@/artifacts/kinds";
import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { useClock } from "@/components/backoffice/use-clock";
import {
  requireRouteScope,
  requireScopeSelection,
} from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { dashboardWorkflowsPath } from "../dashboard/path";
import { filesExplorerPath } from "../files/scope";
import { FilesErrorBoundary } from "../files/shared";
import { pageName, pagePath } from "../pages/path";
import type { Route } from "./+types/artifacts";
import { listArtifacts } from "./list.server";

const WORKSPACE = "/workspace/";
const CLOCK_TICK_MS = 60_000;

export async function loader({ context, url }: Route.LoaderArgs) {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const { execution } = requireRouteScope(context);
  return {
    selectedScope: requireScopeSelection(context),
    listing: await listArtifacts({ runtime, kernel, execution }),
    path: url.pathname,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Artifacts · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <FilesErrorBoundary error={error} params={params} />;
}

export default function BackofficeArtifacts({ loaderData }: Route.ComponentProps) {
  const { selectedScope, listing, path } = loaderData;
  const now = useClock(CLOCK_TICK_MS);

  return (
    <>
      <h1 className="sr-only">Artifacts for {selectedScope.label}</h1>
      <BackofficeTabHeader
        items={[{ id: "artifacts", label: "Artifacts", to: path, active: true }]}
        ariaLabel="Artifacts"
        trailing={null}
        options={null}
      />
      <div className={backofficePageBodyClassName}>
        {listing.kind === "no-workspace" ? (
          <BackofficeSystemState
            tone="empty"
            title="This scope has no workspace."
            description="Pages, sites, and workflows live in a workspace's files. Switch to an organization, a project, or your own workspace to see them."
          />
        ) : (
          <ArtifactsView
            pages={listing.pages.map(({ sourcePath, editedAt }) => {
              const name = pageName(sourcePath);
              return {
                path: sourcePath.slice(WORKSPACE.length),
                name,
                to: pagePath(selectedScope, name),
                filesTo: filesExplorerPath(selectedScope, sourcePath),
                edited: formatRelativeTime(new Date(editedAt), now),
              };
            })}
            workflows={listing.workflows.map(({ sourcePath, editedAt }) => {
              const path = sourcePath.slice(WORKSPACE.length);
              return {
                path,
                name: artifactName(path, "workflow"),
                to: dashboardWorkflowsPath(backofficeRouteScopeFromResolvedScope(selectedScope), {
                  scriptPath: sourcePath,
                  filter: { kind: "all" },
                  run: null,
                }),
                filesTo: filesExplorerPath(selectedScope, sourcePath),
                edited: formatRelativeTime(new Date(editedAt), now),
              };
            })}
            sites={
              listing.sites?.map(
                ({ sitePath, editedAt, serving }): ArtifactSite => ({
                  path: sitePath.slice(WORKSPACE.length),
                  name: sitePath.slice(WORKSPACE.length, -".site".length),
                  filesTo: filesExplorerPath(selectedScope, sitePath),
                  edited: formatRelativeTime(new Date(editedAt), now),
                  serving,
                }),
              ) ?? null
            }
          />
        )}
      </div>
    </>
  );
}
