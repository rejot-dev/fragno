import { Outlet } from "react-router";

import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/scope-layout";
import type { FilesLayoutContext } from "./layout-context";
import { FilesErrorBoundary } from "./shared";

export async function loader({ context, url }: Route.LoaderArgs) {
  return { origin: url.origin, selectedScope: await requireScopeSelection(context) };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Files · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <FilesErrorBoundary error={error} params={params} />;
}

export default function BackofficeFilesScopeLayout({ loaderData }: Route.ComponentProps) {
  const outletContext = {
    scope: backofficeRuntimeScopeFromResolvedScope(loaderData.selectedScope),
    selectedScope: loaderData.selectedScope,
    origin: loaderData.origin,
  } satisfies FilesLayoutContext;

  return (
    <div className="flex h-[calc(100dvh-6.75rem)] min-h-0 flex-col gap-4 overflow-hidden sm:h-[calc(100dvh-4rem)]">
      <h1 className="sr-only">Files for {loaderData.selectedScope.label}</h1>
      <Outlet context={outletContext} />
    </div>
  );
}
