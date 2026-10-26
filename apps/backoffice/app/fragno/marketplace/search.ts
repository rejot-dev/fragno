import type {
  MarketplaceCategory,
  MarketplaceListing,
} from "@fragno-dev/backoffice-api/v0/marketplace";

import type { MarketplaceCommands } from "@/backoffice-runtime/object-registry";

import type { MarketplaceListingPage } from "./contracts";

function marketplaceListingMatches(listing: MarketplaceListing, terms: readonly string[]): boolean {
  const text = [
    listing.listingId,
    listing.name,
    listing.summary,
    listing.description,
    listing.publisherName,
    listing.category,
    ...listing.tags,
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => text.includes(term));
}

/**
 * Each search examines one bounded page of published listings, newest first. A page can have no
 * matches while older candidates remain, so callers follow nextCursor while hasNextPage is true.
 */
export async function searchPublishedListings(
  marketplace: Pick<MarketplaceCommands, "listPublishedListings">,
  input: {
    query: string;
    category: MarketplaceCategory | undefined;
    pageSize: number;
    cursor: string | undefined;
  },
): Promise<MarketplaceListingPage> {
  const page = await marketplace.listPublishedListings({
    category: input.category,
    pageSize: input.pageSize,
    cursor: input.cursor,
  });
  const terms = input.query.toLowerCase().split(/\s+/u);
  return {
    ...page,
    listings: page.listings.filter((listing) => marketplaceListingMatches(listing, terms)),
  };
}
