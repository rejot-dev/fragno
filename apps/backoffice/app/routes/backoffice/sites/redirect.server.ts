import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { redirect, type RouterContextProvider } from "react-router";

import { siteHostOrigin, siteUrl } from "@/artifacts/sites/site-host-names";
import { runtimeSiteHosts } from "@/artifacts/sites/site-hosts.server";
import { siteRequestTarget } from "@/artifacts/sites/site-path";
import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

// `/backoffice/sites/<scopeKind>/<scopeId>/` precedes the site's workspace path.
const SITE_PATH_SEGMENT_OFFSET = 5;

/**
 * Sends a viewer who may read a site of the selected scope to its address at the scope's
 * subdomain. Sites are never served on Backoffice's own origin, where their scripts would run
 * with the viewer's session, so without a sites domain there is nowhere to send them.
 */
export async function redirectToSiteHost({
  request,
  context,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
}): Promise<Response> {
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const sites = runtimeSiteHosts(runtime);
  if (!runtime.config.sites || sites === null) {
    return new Response("Not Found", { status: 404 });
  }
  const scope = backofficeRuntimeScopeFromResolvedScope(requireScopeSelection(context));
  const url = new URL(request.url);
  const target = siteRequestTarget(url.pathname.split("/").slice(SITE_PATH_SEGMENT_OFFSET));
  if (scope.kind === "system" || target === null) {
    return new Response("Not Found", { status: 404 });
  }
  const execution = await requireBackofficeContext(request, context, scope);
  // Only someone who may read the site learns where it is.
  await kernel.assertAuthorizedAll({
    execution,
    requirements: [
      { operation: BACKOFFICE_PERMISSION.upload.read, resource: { path: target.sitePath } },
    ],
  });
  const origin = siteHostOrigin(await sites.hosts.hostFor(scope), sites.domain);
  throw redirect(
    `${siteUrl(origin, target.sitePath)}${(target.pathname ?? "/").slice(1)}${url.search}`,
    308,
  );
}
