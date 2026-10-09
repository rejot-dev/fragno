import {
  marketplaceSearchInputSchema,
  marketplaceSearchResultSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  marketplacePublishInputSchema,
  type MarketplacePublishResult,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  type MarketplaceListingDetail,
  type MarketplacePublishedListingInput,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { MarketplaceObject } from "@/backoffice-runtime/object-registry";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { captureMarketplacePackageSnapshot } from "@/fragno/marketplace/package-manifest";

/** Marketplace discovery reads only published registry metadata, never workspace files. */
export type MarketplaceRuntime = {
  search(
    input: z.output<typeof marketplaceSearchInputSchema>,
  ): Promise<z.output<typeof marketplaceSearchResultSchema>>;
  view(input: MarketplacePublishedListingInput): Promise<MarketplaceListingDetail>;
  publish(input: z.output<typeof marketplacePublishInputSchema>): Promise<MarketplacePublishResult>;
};

/** Each search examines one bounded registry page; callers follow its candidate cursor. */
export function createMarketplaceRuntime(
  object: MarketplaceObject,
  publication: {
    state: BackofficeStateBackend;
    execution: BackofficeExecutionContext;
    kernel: BackofficeKernel;
  } | null,
): MarketplaceRuntime {
  return {
    async publish(input) {
      if (!publication) {
        throw new Error("Marketplace publishing is not available in this execution context.");
      }
      if (
        (input.skipAuthorCheck || input.skipVersionCheck) &&
        publication.execution.scope.kind !== "system"
      ) {
        throw new Error("Marketplace publishing overrides require System context.");
      }
      await publication.kernel.assertAuthorizedAll({
        execution: publication.execution,
        requirements: [
          { operation: BACKOFFICE_PERMISSION.marketplace.publish },
          { operation: BACKOFFICE_PERMISSION.upload.read },
        ],
      });
      const snapshot = await captureMarketplacePackageSnapshot(
        publication.state,
        input.packageRoot,
      );
      return await object.publishPackage(
        {
          snapshot,
          dryRun: input.dryRun,
          skipAuthorCheck: input.skipAuthorCheck,
          skipVersionCheck: input.skipVersionCheck,
        },
        { execution: publication.execution, propagationContext: null },
      );
    },
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
