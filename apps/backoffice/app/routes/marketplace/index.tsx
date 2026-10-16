import "@fragno-private/design-system/components.css";

import {
  MARKETPLACE_MAX_PAGE_SIZE,
  marketplaceSearchInputSchema,
  type MarketplaceListing,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Input } from "@fragno-private/design-system/input";
import { Form, Link } from "react-router";

import { MarketplaceListingCard } from "@/components/marketplace/listing-card";
import type { MarketplaceFeaturedListing } from "@/fragno/marketplace/contracts";
import {
  decodeMarketplaceListingCursor,
  MarketplaceListingCursorError,
} from "@/fragno/marketplace/pagination";
import { searchPublishedListings } from "@/fragno/marketplace/search";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { loadMarketplaceListingRefs } from "../backoffice/marketplace/listing-route.server";
import { LandingFooter } from "../landing/landing-footer";
import { LandingHeader } from "../landing/landing-header";
import type { Route } from "./+types/index";

function publicMarketplaceSearchPath(query: string, cursor: string): string {
  return `/marketplace?${new URLSearchParams({ q: query, cursor })}`;
}

// Anonymous visitors read only the public Marketplace; organization Marketplaces are separate objects.
export async function loader({ context, url }: Route.LoaderArgs) {
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (query && !marketplaceSearchInputSchema._zod.innerType.shape.query.safeParse(query).success) {
    throw new Response("Search query is too long.", { status: 400 });
  }
  const cursor = url.searchParams.get("cursor")?.trim() || undefined;
  try {
    decodeMarketplaceListingCursor({ encodedCursor: cursor });
  } catch (error) {
    if (error instanceof MarketplaceListingCursorError) {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }

  const objects = context.get(BackofficeWorkerContext).runtime.objects;
  const marketplace = objects.marketplace.singleton().commands;
  if (!query) {
    // Browsing shows only the curated set; search reaches every public listing.
    const { listings } = await marketplace.listFeaturedListings();
    const listingRefs = await loadMarketplaceListingRefs(
      objects,
      listings.map(({ listing }) => listing.listingId),
    );
    return { kind: "featured" as const, listings, listingRefs };
  }
  const page = await searchPublishedListings(marketplace, {
    query,
    category: undefined,
    // Search filters one candidate page, so examine as many listings per request as allowed.
    pageSize: MARKETPLACE_MAX_PAGE_SIZE,
    cursor,
  });
  const listingRefs = await loadMarketplaceListingRefs(
    objects,
    page.listings.map((listing) => listing.listingId),
  );
  return { kind: "search" as const, query, ...page, listingRefs };
}

export function meta() {
  const title = "Marketplace · ReJot Backoffice";
  const description =
    "Browse workflows, skills, and supporting files published for ReJot Backoffice.";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
  ];
}

export default function PublicMarketplace({ loaderData }: Route.ComponentProps) {
  const query = loaderData.kind === "search" ? loaderData.query : "";

  return (
    <div
      data-backoffice-root
      className="flex min-h-svh flex-col bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader />
      <main className="mx-auto w-full max-w-[1180px] flex-1 px-5 pt-14 pb-24 sm:px-8 lg:px-12 lg:pt-20">
        <h1 className="max-w-3xl text-[clamp(2.75rem,6vw,5.5rem)] leading-[0.92] font-[560] tracking-[-0.065em] text-balance">
          Marketplace
        </h1>
        <p className="mt-6 max-w-2xl text-[clamp(0.95rem,1.4vw,1.05rem)] leading-7 text-pretty text-[var(--bo-muted)]">
          Workflows, skills, and supporting files shared by Backoffice publishers. Install any
          package into your workspace and adapt it to your business.
        </p>

        <Form method="get" role="search" className="mt-10 flex max-w-2xl gap-2">
          <label htmlFor="marketplace-search" className="sr-only">
            Search packages
          </label>
          <Input
            // Remount on navigation so the field reflects the active query.
            key={query}
            id="marketplace-search"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Search by name, publisher, or tag"
            maxLength={240}
            autoComplete="off"
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="solid">
            Search
          </Button>
        </Form>

        {loaderData.kind === "featured" ? (
          <FeaturedListings listings={loaderData.listings} listingRefs={loaderData.listingRefs} />
        ) : (
          <SearchResults
            query={loaderData.query}
            listingRefs={loaderData.listingRefs}
            listings={loaderData.listings}
            nextCursor={loaderData.nextCursor}
            hasNextPage={loaderData.hasNextPage}
          />
        )}
      </main>
      <LandingFooter />
    </div>
  );
}

function FeaturedListings({
  listings,
  listingRefs,
}: {
  listings: readonly MarketplaceFeaturedListing[];
  listingRefs: Record<string, string>;
}) {
  return (
    <section aria-labelledby="public-marketplace-featured" className="mt-12">
      <h2
        id="public-marketplace-featured"
        className="mb-4 text-lg font-semibold tracking-tight text-[var(--bo-fg)]"
      >
        Featured packages
      </h2>
      {listings.length === 0 ? (
        <div className="bo-panel-surface bg-[var(--bo-panel)] px-6 py-16 text-center">
          <p className="text-lg font-semibold text-balance text-[var(--bo-fg)]">
            Nothing is featured right now.
          </p>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            Search above to find every published package.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {listings.map(({ listing, note }, index) => (
            <MarketplaceListingCard
              key={listing.listingId}
              listing={listing}
              to={`/marketplace/${listingRefs[listing.listingId]}`}
              presentation={{ kind: "featured", lead: index === 0, note }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SearchResults({
  listingRefs,
  query,
  listings,
  nextCursor,
  hasNextPage,
}: {
  query: string;
  listingRefs: Record<string, string>;
  listings: readonly MarketplaceListing[];
  nextCursor: string | undefined;
  hasNextPage: boolean;
}) {
  return (
    <section aria-labelledby="public-marketplace-results" className="mt-12">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h2
          id="public-marketplace-results"
          className="text-lg font-semibold tracking-tight text-[var(--bo-fg)]"
        >
          Results for “{query}”
        </h2>
        <Link
          to="/marketplace"
          className="text-xs font-medium text-[var(--bo-muted)] underline-offset-4 hover:text-[var(--bo-fg)] hover:underline"
        >
          Clear search
        </Link>
      </div>

      {listings.length === 0 ? (
        <div className="bo-panel-surface bg-[var(--bo-panel)] px-6 py-16 text-center">
          <p className="text-lg font-semibold text-balance text-[var(--bo-fg)]">
            {hasNextPage ? "No matches among these packages." : `No packages match “${query}”.`}
          </p>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            {hasNextPage
              ? "Older packages may still match. Continue searching below."
              : "Try fewer or different words."}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {listings.map((listing) => (
            <MarketplaceListingCard
              key={listing.listingId}
              listing={listing}
              to={`/marketplace/${listingRefs[listing.listingId]}`}
              presentation={{ kind: "catalog" }}
            />
          ))}
        </div>
      )}

      {hasNextPage && nextCursor ? (
        <div className="mt-6 flex justify-center">
          <ButtonLink to={publicMarketplaceSearchPath(query, nextCursor)} variant="secondary">
            Search older packages →
          </ButtonLink>
        </div>
      ) : null}
    </section>
  );
}
