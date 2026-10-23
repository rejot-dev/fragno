import type { PageLoad } from "@fragno-private/backoffice-ui/pages/definition";
import type { RouterContextProvider } from "react-router";

import { loadPage } from "@/artifacts/pages/build.server";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import {
  requireRouteScope,
  requireScopeSelection,
} from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { PAGE_SOURCES_GLOB, pageSourcePath } from "./path";

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

export type PageSources =
  | { kind: "listed"; sourcePaths: string[] }
  | { kind: "failed"; message: string };

/**
 * The page sources of the route's scope, which the dashboard offers to open. Loaders stream it
 * without awaiting, so it never rejects: a rejection would replace the whole route with its error
 * boundary long after it rendered, or go unhandled when the loader throws first.
 */
export async function loadPageSources(
  context: Readonly<RouterContextProvider>,
): Promise<PageSources> {
  try {
    const { runtime, kernel } = context.get(BackofficeWorkerContext);
    const { execution } = requireRouteScope(context);
    return {
      kind: "listed",
      sourcePaths: await listPageSources({ runtime, kernel, execution }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "failed", message: `Pages could not be listed: ${reason}` };
  }
}

/** Every page source the execution can read, sorted by path. */
export async function listPageSources({
  runtime,
  kernel,
  execution,
}: {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
}): Promise<string[]> {
  // System scope has no workspace, and runtimes without Upload have none either.
  if (execution.scope.kind === "system") {
    return [];
  }
  const state = createCodemodeRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime,
    kernel,
    execution,
  }).stateBackend;
  return state ? await state.glob(PAGE_SOURCES_GLOB) : [];
}
