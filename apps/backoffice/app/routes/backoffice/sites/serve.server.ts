import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { redirect, type RouterContextProvider } from "react-router";

import { siteFilesCacheFor, siteStoreForServing } from "@/artifacts/sites/assets.server";
import {
  createSitePointerCache,
  exportedSiteWorkerBindings,
  serveSite,
} from "@/artifacts/sites/serve.server";
import { isSitePath } from "@/artifacts/sites/site-path";
import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

// Each isolate shares its recent reads of site pointers across requests.
const pointers = createSitePointerCache(() => Date.now());

// `/backoffice/sites/<scopeKind>/<scopeId>/` precedes the site's workspace path.
const SITE_PATH_SEGMENT_OFFSET = 5;

/**
 * Serves a site of the selected scope to a signed-in viewer who may read its workspace, where the
 * deployment enables sites.
 */
export async function serveSiteRoute({
  request,
  context,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
}): Promise<Response> {
  const { runtime, kernel, ctx } = context.get(BackofficeWorkerContext);
  if (!runtime.config.sites) {
    return new Response("Not Found", { status: 404 });
  }
  const scope = backofficeRuntimeScopeFromResolvedScope(requireScopeSelection(context));
  const url = new URL(request.url);
  const target = siteRequestTarget(url.pathname);
  if (scope.kind === "system" || target === null) {
    return new Response("Not Found", { status: 404 });
  }
  // Relative URLs in the site's pages resolve against its root only with the trailing slash.
  if (target.pathname === null) {
    throw redirect(`${url.pathname}/${url.search}`, 308);
  }
  const execution = await requireBackofficeContext(request, context, scope);
  // The build is read as the system below, so the viewer's right to read the site is checked here.
  await kernel.assertAuthorizedAll({
    execution,
    requirements: [
      { operation: BACKOFFICE_PERMISSION.upload.read, resource: { path: target.sitePath } },
    ],
  });
  return await serveSite({
    request,
    store: siteStoreForServing({
      runtime,
      scope,
      sitePath: target.sitePath,
      cache: siteFilesCacheFor(runtime, request, (promise) => {
        ctx.waitUntil(promise);
      }),
    }),
    pointers,
    bindings: exportedSiteWorkerBindings(runtime.workerLoader, ctx.exports),
    scope,
    sitePath: target.sitePath,
    pathname: target.pathname,
  });
}

/**
 * The site a request path names and the path within it, as spelled:
 * `…/tools/shop.site/api/orders` is `/workspace/tools/shop.site` at `/api/orders`, and the pathname
 * is null at the site's root without its trailing slash.
 */
function siteRequestTarget(
  requestPath: string,
): { sitePath: string; pathname: string | null } | null {
  const segments = requestPath.split("/").slice(SITE_PATH_SEGMENT_OFFSET);
  let names: string[];
  try {
    names = segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  // Sites cannot nest, so the first `.site` segment ends the site's path.
  const siteEnd = names.findIndex((name) => name.endsWith(".site"));
  if (siteEnd === -1) {
    return null;
  }
  const sitePath = `/workspace/${names.slice(0, siteEnd + 1).join("/")}`;
  if (!isSitePath(sitePath)) {
    return null;
  }
  const rest = segments.slice(siteEnd + 1);
  return { sitePath, pathname: rest.length === 0 ? null : `/${rest.join("/")}` };
}
