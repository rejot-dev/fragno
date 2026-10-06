import { z } from "zod";

import type { MarketplaceObject } from "@/backoffice-runtime/object-registry";
import {
  marketplaceListingPageInputSchema,
  marketplacePublicListingSchema,
  type MarketplaceListingDetail,
  type MarketplacePublishedListingInput,
} from "@/fragno/marketplace/contracts";

/** Search cursors advance through registry candidates, including pages without matches. */
export const marketplaceSearchInputSchema = marketplaceListingPageInputSchema.extend({
  query: z.string().trim().min(1).max(240),
});

/** Registry search returns compact metadata and a cursor for the next candidate page. */
export const marketplaceSearchResultSchema = z.object({
  listings: z.array(
    marketplacePublicListingSchema.pick({
      listingId: true,
      name: true,
      summary: true,
      publisherName: true,
      category: true,
      tags: true,
      latestVersion: true,
    }),
  ),
  nextCursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

/** Marketplace discovery reads only published registry metadata, never workspace files. */
export type MarketplaceRuntime = {
  search(
    input: z.output<typeof marketplaceSearchInputSchema>,
  ): Promise<z.output<typeof marketplaceSearchResultSchema>>;
  view(input: MarketplacePublishedListingInput): Promise<MarketplaceListingDetail>;
};

/** Each search examines one bounded registry page; callers follow its candidate cursor. */
export function createMarketplaceRuntime(object: MarketplaceObject): MarketplaceRuntime {
  return {
    async search({ query, ...input }) {
      const page = await object.listPublishedListings(input);
      const terms = query.toLowerCase().split(/\s+/u);
      const listings = page.listings.filter((listing) => {
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
      });
      return {
        listings: listings.map((listing) => ({
          listingId: listing.listingId,
          name: listing.name,
          summary: listing.summary,
          publisherName: listing.publisherName,
          category: listing.category,
          tags: listing.tags,
          latestVersion: listing.latestVersion,
        })),
        nextCursor: page.nextCursor ?? null,
        hasNextPage: page.hasNextPage,
      };
    },
    async view(input) {
      const detail = await object.getPublishedListing(input);
      if (!detail) {
        throw new Error(`Marketplace listing '${input.listingId}' was not found.`);
      }
      return detail;
    },
  };
}
