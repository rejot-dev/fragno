import { redirect } from "react-router";

import type { BackofficeRoutableScopeSelection } from "@/backoffice-runtime/resolved-scope";
import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/index";
import { resolveMarketplaceListingRoute } from "./listing-route.server";
import { marketplaceListingPath } from "./navigation";
import { marketplaceScopeTabPath } from "./scope";

export async function loader({ context, url }: Route.LoaderArgs) {
  const { me } = getBackofficeShellRequest(context);

  const organization = me.activeOrganization?.organization;
  const scope: BackofficeRoutableScopeSelection = organization
    ? { kind: "org", organization, label: organization.name ?? organization.id }
    : {
        kind: "user",
        userId: me.user.id,
        jurisdiction: me.user.jurisdiction,
        label: me.user.email ?? me.user.id,
      };

  // Public listing pages link here so installation opens in the visitor's active workspace.
  const listingRef = url.searchParams.get("listing");
  if (listingRef === null) {
    return redirect(marketplaceScopeTabPath(scope));
  }
  const [publisherSegment, ...slugParts] = listingRef.split("/");
  let publisher: string;
  try {
    publisher = decodeURIComponent(publisherSegment);
  } catch {
    throw new Response("Not Found", { status: 404 });
  }
  const listing = await resolveMarketplaceListingRoute(
    context.get(BackofficeWorkerContext).runtime.objects,
    {
      publisher,
      packageSlug: slugParts.join("/"),
    },
  );
  return redirect(marketplaceListingPath(listing.listingRef, scope, "marketplace"));
}

export default function BackofficeMarketplaceIndex() {
  return null;
}
