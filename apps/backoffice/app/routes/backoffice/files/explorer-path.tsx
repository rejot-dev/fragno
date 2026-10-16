import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/explorer-path";
import { loadFilesExplorerData } from "./data";

export { default } from "./explorer";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const scope = backofficeRuntimeScopeFromResolvedScope(await requireScopeSelection(context));
  return loadFilesExplorerData({
    request,
    context,
    scope,
    requestedPath: readExplorerPath(params["*"]),
  });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const selectedTitle = loaderData?.selectedPath?.split("/").filter(Boolean).at(-1);
  return [{ title: selectedTitle ? `Files · ${selectedTitle}` : "Files Explorer" }];
}

function readExplorerPath(splat: string | undefined): string | null {
  const path = splat?.replace(/^\/+|\/+$/gu, "");
  return path ? `/${path}` : null;
}
