import type { RouterContextProvider } from "react-router";

import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { resolveMarketplaceListingRoute } from "./listing-route.server";
import { fetchPublishedMarketplacePackageFile } from "./package-files.server";
import { marketplaceForCatalog } from "./scope";

type MarketplacePackageFileLoaderArgs = {
  request: Request;
  url: URL;
  params: Record<string, string | undefined>;
  context: Readonly<RouterContextProvider>;
};

export async function loadMarketplacePackageFile({
  request,
  params,
  context,
  url,
}: MarketplacePackageFileLoaderArgs) {
  const { marketplace } = marketplaceForCatalog(
    requireRouteScope(context).execution.scope,
    params.catalog,
  );

  const path = url.searchParams.get("packagePath")?.trim();
  if (!path) {
    throw new Response("packagePath is required", { status: 400 });
  }

  const runtime = context.get(BackofficeWorkerContext).runtime;
  const { listingId } = await resolveMarketplaceListingRoute(runtime.objects, params);
  const manifest = await runtime.objects.marketplace.for(marketplace).commands.getListingStorage({
    listingId,
  });
  return fetchPublishedMarketplacePackageFile({
    manifest,
    objects: runtime.objects,
    request,
    path,
  });
}
