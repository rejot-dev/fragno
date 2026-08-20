import type { RouterContextProvider } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { fetchPublishedMarketplaceArtifactFile } from "./artifact-files.server";
import { marketplaceListingRefSchema } from "./navigation";
import { marketplaceScopeFromRouteParams } from "./scope";

type MarketplaceArtifactFileLoaderArgs = {
  request: Request;
  url: URL;
  params: { scopeKind?: string; scopeId?: string; listingRef?: string };
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

  const scope = marketplaceScopeFromRouteParams(params);
  const canAccessScope =
    scope.kind === "user"
      ? scope.userId === me.user.id
      : me.organizations.some(({ organization }) => organization.id === scope.orgId);
  const listingId = marketplaceListingRefSchema.safeParse(params.listingRef);
  if (!canAccessScope || !listingId.success) {
    throw new Response("Not Found", { status: 404 });
  }

  const path = url.searchParams.get("artifactPath")?.trim();
  if (!path) {
    throw new Response("artifactPath is required", { status: 400 });
  }

  const runtime = context.get(BackofficeWorkerContext).runtime;
  const manifest = await runtime.objects.marketplace.singleton().getArtifactManifest({
    listingId: listingId.data,
  });
  return fetchPublishedMarketplaceArtifactFile({
    manifest,
    objects: runtime.objects,
    request,
    path,
  });
}
