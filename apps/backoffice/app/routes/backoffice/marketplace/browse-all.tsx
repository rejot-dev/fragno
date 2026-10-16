import { ButtonLink } from "@fragno-private/design-system/button";
import { useOutletContext } from "react-router";

import { MarketplaceListingCard } from "@/components/marketplace/listing-card";
import {
  decodeMarketplaceListingCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/browse-all";
import { MarketplaceCatalogViewTabs } from "./catalog-view-tabs";
import type { MarketplaceLayoutContext } from "./layout-context";
import { loadMarketplaceListingRefs } from "./listing-route.server";
import { marketplaceListingPath } from "./navigation";
import { marketplaceForCatalog } from "./scope";

function marketplacePagePath(basePath: string, cursor: string): string {
  return `${basePath}?${new URLSearchParams({ cursor })}`;
}

export async function loader({ params, context, url }: Route.LoaderArgs) {
  const { catalog, marketplace: marketplaceScope } = marketplaceForCatalog(
    requireRouteScope(context).execution.scope,
    params.catalog,
  );
  const cursor = url.searchParams.get("cursor")?.trim() || undefined;
  try {
    decodeMarketplaceListingCursor({ encodedCursor: cursor });
  } catch (error) {
    if (error instanceof MarketplaceListingCursorError) {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }

  const marketplace = context
    .get(BackofficeWorkerContext)
    .runtime.objects.marketplace.for(marketplaceScope).commands;
  const page = await marketplace.listPublishedListings(cursor ? { cursor } : {});
  const listingRefs = await loadMarketplaceListingRefs(
    context.get(BackofficeWorkerContext).runtime.objects,
    page.listings.map((listing) => listing.listingId),
  );
  return { basePath: url.pathname, catalog, ...page, listingRefs };
}

export function meta() {
  return [
    { title: "All packages · Marketplace" },
    {
      name: "description",
      content: "Discover versioned automation packages ready to install.",
    },
  ];
}

export default function BackofficeMarketplaceBrowseAll({ loaderData }: Route.ComponentProps) {
  const { selectedScope } = useOutletContext<MarketplaceLayoutContext>();
  const { basePath, catalog, listings, nextCursor, hasNextPage } = loaderData;
  const isOrganizationCatalog = catalog === "organization";

  return (
    <div className="space-y-5">
      <MarketplaceCatalogViewTabs scope={selectedScope} catalog={catalog} activeView="all" />
      {listings.length === 0 ? (
        <section className="bo-panel-surface bg-[var(--bo-panel)] px-6 py-16 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
            {isOrganizationCatalog
              ? "No automations published for your organization yet."
              : "No published automations yet."}
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            {isOrganizationCatalog
              ? "Packages published with organization visibility appear here for members only."
              : "Published packages will appear here when they are ready to install."}
          </p>
        </section>
      ) : (
        <section aria-labelledby="all-marketplace-heading">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3 px-1">
            <h2
              id="all-marketplace-heading"
              className="text-lg font-semibold tracking-tight text-[var(--bo-fg)]"
            >
              {isOrganizationCatalog ? "All organization packages" : "All packages"}
            </h2>
            <p className="text-[9px] tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
              {listings.length}
              {hasNextPage ? "+" : ""} available
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {listings.map((listing) => (
              <MarketplaceListingCard
                key={listing.listingId}
                listing={listing}
                to={marketplaceListingPath(
                  loaderData.listingRefs[listing.listingId],
                  selectedScope,
                  catalog,
                )}
                presentation={{ kind: "catalog" }}
              />
            ))}
          </div>
        </section>
      )}

      {hasNextPage && nextCursor ? (
        <div className="flex justify-center pt-1">
          <ButtonLink to={marketplacePagePath(basePath, nextCursor)} variant="secondary">
            Show more automations →
          </ButtonLink>
        </div>
      ) : null}
    </div>
  );
}
