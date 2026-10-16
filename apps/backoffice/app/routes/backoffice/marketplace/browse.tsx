import { ButtonLink } from "@fragno-private/design-system/button";
import { useOutletContext } from "react-router";

import { MarketplaceListingCard } from "@/components/marketplace/listing-card";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/browse";
import { MarketplaceCatalogViewTabs } from "./catalog-view-tabs";
import type { MarketplaceLayoutContext } from "./layout-context";
import { loadMarketplaceListingRefs } from "./listing-route.server";
import { marketplaceCatalogAllPath, marketplaceListingPath } from "./navigation";
import { marketplaceForCatalog } from "./scope";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { catalog, marketplace: marketplaceScope } = marketplaceForCatalog(
    requireRouteScope(context).execution.scope,
    params.catalog,
  );
  const { listings } = await context
    .get(BackofficeWorkerContext)
    .runtime.objects.marketplace.for(marketplaceScope)
    .commands.listFeaturedListings();
  const listingRefs = await loadMarketplaceListingRefs(
    context.get(BackofficeWorkerContext).runtime.objects,
    listings.map(({ listing }) => listing.listingId),
  );
  return { catalog, listings, listingRefs };
}

export function meta() {
  return [
    { title: "Featured packages · Marketplace" },
    {
      name: "description",
      content: "Discover curated automation packages ready to install.",
    },
  ];
}

export default function BackofficeMarketplaceFeatured({ loaderData }: Route.ComponentProps) {
  const { selectedScope } = useOutletContext<MarketplaceLayoutContext>();
  const { catalog, listings } = loaderData;
  const isOrganizationCatalog = catalog === "organization";

  return (
    <div className="space-y-5">
      <MarketplaceCatalogViewTabs scope={selectedScope} catalog={catalog} activeView="featured" />
      {listings.length === 0 ? (
        <section className="bo-panel-surface bg-[var(--bo-panel)] px-6 py-16 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
            Nothing is featured yet.
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            {isOrganizationCatalog
              ? "Organization owners and admins feature packages with marketplace.feature."
              : "System administrators feature packages with marketplace.feature."}
          </p>
          <ButtonLink
            to={marketplaceCatalogAllPath(selectedScope, catalog)}
            variant="secondary"
            className="mt-6"
          >
            Browse all packages →
          </ButtonLink>
        </section>
      ) : (
        <section aria-labelledby="featured-marketplace-heading">
          <div className="mb-3 px-1">
            <h2
              id="featured-marketplace-heading"
              className="text-lg font-semibold tracking-tight text-[var(--bo-fg)]"
            >
              {isOrganizationCatalog ? "Featured for your organization" : "Featured packages"}
            </h2>
            <p className="mt-1 text-xs text-[var(--bo-muted)]">
              {isOrganizationCatalog
                ? "Picked by your organization's admins."
                : "Picked by the Backoffice team."}
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {listings.map(({ listing, note }, index) => (
              <MarketplaceListingCard
                key={listing.listingId}
                listing={listing}
                to={marketplaceListingPath(
                  loaderData.listingRefs[listing.listingId],
                  selectedScope,
                  catalog,
                )}
                presentation={{ kind: "featured", lead: index === 0, note }}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
