import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import { Outlet, useLocation } from "react-router";

import { isBackofficeObjectAvailableInContext } from "@/backoffice-runtime/object-registry";
import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/scope-layout";
import type { FilesLayoutContext } from "./layout-context";
import { filesExplorerPath, largeFilesPath } from "./scope";
import { FilesErrorBoundary } from "./shared";

export async function loader({ context, url }: Route.LoaderArgs) {
  const selectedScope = requireScopeSelection(context);
  const { runtime } = context.get(BackofficeWorkerContext);
  return {
    origin: url.origin,
    selectedScope,
    hasLargeFiles:
      runtime.config.bindings.blobs &&
      isBackofficeObjectAvailableInContext(
        "BLOBS",
        backofficeRuntimeScopeFromResolvedScope(selectedScope),
      ),
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Files · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <FilesErrorBoundary error={error} params={params} />;
}

export default function BackofficeFilesScopeLayout({ loaderData }: Route.ComponentProps) {
  const { selectedScope, hasLargeFiles } = loaderData;
  const { pathname } = useLocation();
  const largeFilesTo = largeFilesPath(selectedScope);
  const onLargeFiles = pathname === largeFilesTo;
  const outletContext = {
    scope: backofficeRuntimeScopeFromResolvedScope(selectedScope),
    selectedScope,
    origin: loaderData.origin,
  } satisfies FilesLayoutContext;

  return (
    <div className="flex h-[var(--bo-page-height)] min-h-0 flex-col overflow-hidden">
      <h1 className="sr-only">Files for {selectedScope.label}</h1>
      {/* Large files sit in their own tab because the explorer's search never reaches them. */}
      <BackofficeTabHeader
        items={[
          {
            id: "files",
            label: "Files",
            to: filesExplorerPath(selectedScope),
            active: !onLargeFiles,
          },
          ...(hasLargeFiles || onLargeFiles
            ? [{ id: "large-files", label: "Large files", to: largeFilesTo, active: onLargeFiles }]
            : []),
        ]}
        ariaLabel="File storage"
        trailing={null}
        options={null}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <Outlet context={outletContext} />
      </div>
    </div>
  );
}
