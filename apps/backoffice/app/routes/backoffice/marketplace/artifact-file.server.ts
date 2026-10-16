import type { RouterContextProvider } from "react-router";

import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { fetchPublishedMarketplaceArtifactFile } from "./artifact-files.server";
import { resolveMarketplaceListingRoute } from "./listing-route.server";
import { marketplaceForCatalog } from "./scope";

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
  const { marketplace } = marketplaceForCatalog(
    requireRouteScope(context).execution.scope,
    params.catalog,
  );

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
