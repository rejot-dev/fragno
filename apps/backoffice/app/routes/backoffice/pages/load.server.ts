import type { PageLoad } from "@fragno-private/backoffice-ui/pages/definition";
import type { RouterContextProvider } from "react-router";

import { loadPage } from "@/artifacts/pages/build.server";
import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { pageSourcePath } from "./path";

/** Loads a page of the selected scope for the signed-in viewer; system scope has no workspace. */
export async function loadPageRoute({
  request,
  context,
  name,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  name: string;
}): Promise<PageLoad> {
  const scope = backofficeRuntimeScopeFromResolvedScope(requireScopeSelection(context));
  const sourcePath = pageSourcePath(name);
  if (scope.kind === "system" || sourcePath === null) {
    return { kind: "missing" };
  }
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const execution = await requireBackofficeContext(request, context, scope);
  return await loadPage({ runtime, kernel, execution, sourcePath });
}
