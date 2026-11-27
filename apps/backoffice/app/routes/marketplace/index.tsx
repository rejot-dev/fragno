import "@fragno-private/design-system/components.css";

import {
  MARKETPLACE_MAX_PAGE_SIZE,
  marketplaceSearchInputSchema,
  type MarketplaceListing,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { ButtonLink } from "@fragno-private/design-system/controls/button";
import {
  PillArrow,
  PillButton,
  PillLabel,
} from "@fragno-private/design-system/controls/pill-button";
import { Icon } from "@fragno-private/design-system/icon";
import { LandingHeroPhotoPlaceholder } from "@fragno-private/design-system/landing/hero-photo";
import {
  LANDING_SECTION_INTRO_CLASS_NAME,
  LANDING_SECTION_TITLE_CLASS_NAME,
} from "@fragno-private/design-system/landing/landing-section";
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
import { LandingColumnLines, LandingHeader } from "../landing/landing-header";
import { useScrolled } from "../landing/use-scrolled";
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
  const title = "Marketplace · Leyway";
  const description = "Browse workflows, skills, and supporting files published for Leyway.";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
  ];
}

export default function PublicMarketplace({ loaderData }: Route.ComponentProps) {
  const query = loaderData.kind === "search" ? loaderData.query : "";
  const scrolled = useScrolled();

  return (
    <div
      data-backoffice-root
      className="bo-grid-backdrop flex min-h-svh flex-col overflow-x-clip bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader startsOverDark={true} nav="product" />
      {/* Only the page's own content is main, so the header and footer keep their banner and
          contentinfo landmarks. */}
      <main className="flex flex-1 flex-col">
        {/* The homepage's hero, shorter and without its mountains: the photo's colors, as the
          homepage shows them while the photo loads, under the same grainy film, running up behind
          the header and padded back down by its height and border, with the
          copy in white. */}
        <section
          data-scrolled={scrolled || undefined}
          data-landing-dark
          className="group/hero relative -mt-[calc(var(--spacing)*16+1px)] overflow-hidden bg-[#232322] pt-[calc(var(--spacing)*16+1px)] text-white"
        >
          <div aria-hidden="true" className="landing-film-mono">
            <LandingHeroPhotoPlaceholder photo="fitz-roy" />
          </div>
          <div className="max-w-landing relative z-10 mx-auto w-full px-7 pt-20 pb-24 sm:px-8 sm:pt-28 sm:pb-28 lg:px-12 lg:pt-36 lg:pb-32">
            <h1 className="font-heading text-[clamp(2.5rem,5.75vw,5rem)] leading-[1.05] font-light tracking-[-0.02em] text-balance">
              Marketplace
            </h1>
            <p className="mt-8 max-w-2xl text-xl leading-8 text-pretty text-white">
              Workflows, skills, and supporting files shared by Leyway publishers. Install any
              package into your workspace and adapt it to your business.
            </p>

            {/* A frosted pill on the film, with the homepage's white call to action inside it. */}
            <Form
              method="get"
              role="search"
              // Frosted dark rather than light, so white text and its placeholder stay readable
              // over the film's lightest part.
              className="mt-10 flex max-w-2xl items-center gap-2 rounded-full border border-white/30 bg-black/35 p-1.5 pl-5 backdrop-blur-md transition-colors duration-150 focus-within:border-white/60"
            >
              <Icon name="search" className="size-4 shrink-0 text-white/80" />
              <label htmlFor="marketplace-search" className="sr-only">
                Search packages
              </label>
              <input
                // Remount on navigation so the field reflects the active query.
                key={query}
                id="marketplace-search"
                name="q"
                type="search"
                defaultValue={query}
                placeholder="Search by name, publisher, or tag"
                maxLength={240}
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent py-2 text-base text-white outline-none placeholder:text-white/80"
              />
              {/* White on the film, in its own ink rather than the page's. */}
              <PillButton
                type="submit"
                variant="filled"
                size="compact"
                ring={false}
                className="shrink-0 [--bo-bg:#0b0b0a] [--bo-fg:#ffffff]"
              >
                <PillLabel>Search</PillLabel>
                <PillArrow />
              </PillButton>
            </Form>
          </div>
          <LandingColumnLines />
        </section>

        <div className="max-w-landing mx-auto w-full flex-1 px-7 pt-16 pb-24 sm:px-8 sm:pt-20 sm:pb-32 lg:px-12">
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
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}

/** An empty result, in a flat card: it holds no visual, so it is not lifted off the page. */
function EmptyListings({ title, children }: { title: string; children: string }) {
  return (
    <div className="rounded-[14px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-6 py-16 text-center">
      <p className="font-heading text-2xl font-light tracking-[-0.02em] text-balance">{title}</p>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
        {children}
      </p>
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
    <section aria-labelledby="public-marketplace-featured">
      <h2 id="public-marketplace-featured" className={LANDING_SECTION_TITLE_CLASS_NAME}>
        Featured packages
      </h2>
      <p className={LANDING_SECTION_INTRO_CLASS_NAME}>
        Picked by the Leyway team. Search above to reach every published package.
      </p>
      {listings.length === 0 ? (
        <div className="mt-10">
          <EmptyListings title="Nothing is featured right now.">
            Search above to find every published package.
          </EmptyListings>
        </div>
      ) : (
        <div className="mt-10 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
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
    <section aria-labelledby="public-marketplace-results">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        {/* The query can be one long unbroken term, which must wrap on phones. */}
        <h2
          id="public-marketplace-results"
          className={`${LANDING_SECTION_TITLE_CLASS_NAME} wrap-anywhere`}
        >
          Results for “{query}”
        </h2>
        <Link
          to="/marketplace"
          className="pb-1.5 text-sm font-medium text-[var(--bo-muted)] underline-offset-4 hover:text-[var(--bo-fg)] hover:underline"
        >
          Clear search
        </Link>
      </div>

      {listings.length === 0 ? (
        <div className="mt-10">
          <EmptyListings
            title={
              hasNextPage ? "No matches among these packages." : `No packages match “${query}”.`
            }
          >
            {hasNextPage
              ? "Older packages may still match. Continue searching below."
              : "Try fewer or different words."}
          </EmptyListings>
        </div>
      ) : (
        <div className="mt-10 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
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
