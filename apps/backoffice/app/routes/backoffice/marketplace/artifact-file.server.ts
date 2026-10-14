import type { RouterContextProvider } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { fetchPublishedMarketplaceArtifactFile } from "./artifact-files.server";
import { resolveMarketplaceListingRoute } from "./listing-route.server";
import { marketplaceFromRouteParams } from "./scope";

type MarketplaceArtifactFileLoaderArgs = {
  request: Request;
  url: URL;
  params: Record<string, string | undefined>;
  context: Readonly<RouterContextProvider>;
};

export async function loadMarketplaceArtifactFile({
  request,
  params,
  context,
  url,
}: MarketplaceArtifactFileLoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const { scope, marketplace } = marketplaceFromRouteParams(params, me);
  // System scope was restricted to System administrators when the route was resolved.
  const canAccessScope =
    scope.kind === "system" ||
    (scope.kind === "user"
      ? scope.userId === me.user.id
      : me.organizations.some(({ organization }) => organization.id === scope.orgId));
  if (!canAccessScope) {
    throw new Response("Not Found", { status: 404 });
  }

  const path = url.searchParams.get("artifactPath")?.trim();
  if (!path) {
    throw new Response("artifactPath is required", { status: 400 });
  }

  const runtime = context.get(BackofficeWorkerContext).runtime;
  const { listingId } = await resolveMarketplaceListingRoute(runtime.objects, params);
  const manifest = await runtime.objects.marketplace.for(marketplace).commands.getArtifactManifest({
    listingId,
  });
  return fetchPublishedMarketplaceArtifactFile({
    manifest,
    objects: runtime.objects,
    request,
    path,
  });
}
