import {
  marketplaceSearchInputSchema,
  marketplaceSearchResultSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  marketplacePublishInputSchema,
  type MarketplacePublishResult,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  marketplaceViewInputSchema,
  type MarketplaceListingDetail,
  type MarketplaceScope,
  type MarketplaceVisibility,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { marketplaceScopeForVisibility } from "@/fragno/marketplace/owner";
import { captureMarketplacePackageSnapshot } from "@/fragno/marketplace/package-manifest";
import { resolveMarketplacePackageOwner } from "@/fragno/marketplace/package-publishing";

/** Marketplace discovery reads only published registry metadata, never workspace files. */
export type MarketplaceRuntime = {
  search(
    input: z.output<typeof marketplaceSearchInputSchema>,
  ): Promise<z.output<typeof marketplaceSearchResultSchema>>;
  view(input: z.output<typeof marketplaceViewInputSchema>): Promise<MarketplaceListingDetail>;
  publish(input: z.output<typeof marketplacePublishInputSchema>): Promise<MarketplacePublishResult>;
};

/** Discovery reads the public or current organization's Marketplace; publishing targets the package owner's. */
export function createMarketplaceRuntime({
  objects,
  execution,
  publication,
}: {
  objects: BackofficeObjectRegistry;
  execution: BackofficeExecutionContext;
  publication: {
    state: BackofficeStateBackend;
    kernel: BackofficeKernel;
  } | null;
}): MarketplaceRuntime {
  // The organization comes from the execution scope, so callers cannot read another organization's Marketplace.
  function readableMarketplace(visibility: MarketplaceVisibility) {
    if (visibility === "public") {
      return objects.marketplace.singleton().commands;
    }
    if (execution.scope.kind !== "org" && execution.scope.kind !== "project") {
      throw new BackofficeOperationError(
        "forbidden",
        "Organization Marketplace reads require an organization or project workspace.",
      );
    }
    const marketplace: MarketplaceScope = { kind: "org", orgId: execution.scope.orgId };
    return objects.marketplace.for(marketplace).commands;
  }

  return {
    async publish(input) {
      if (!publication) {
        throw new Error("Marketplace publishing is not available in this execution context.");
      }
      if ((input.skipAuthorCheck || input.skipVersionCheck) && execution.scope.kind !== "system") {
        throw new Error("Marketplace publishing overrides require System context.");
      }
      await publication.kernel.assertAuthorizedAll({
        execution,
        requirements: [
          { operation: BACKOFFICE_PERMISSION.marketplace.publish },
          { operation: BACKOFFICE_PERMISSION.upload.read },
        ],
      });
      const snapshot = await captureMarketplacePackageSnapshot(
        publication.state,
        input.packageRoot,
      );
      const owner = await resolveMarketplacePackageOwner(objects, snapshot.manifest.name);
      const marketplace = marketplaceScopeForVisibility(input.visibility, owner.scope);
      return await objects.marketplace.for(marketplace).commands.publishPackage(
        {
          snapshot,
          visibility: input.visibility,
          dryRun: input.dryRun,
          skipAuthorCheck: input.skipAuthorCheck,
          skipVersionCheck: input.skipVersionCheck,
        },
        { execution, propagationContext: null },
      );
    },
    async search({ query, visibility, ...input }) {
      const page = await readableMarketplace(visibility).listPublishedListings(input);
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
    async view({ visibility, ...input }) {
      const detail = await readableMarketplace(visibility).getPublishedListing(input);
      if (!detail) {
        throw new BackofficeOperationError(
          "not_found",
          `Marketplace listing '${input.listingId}' was not found.`,
        );
      }
      return detail;
    },
  };
}
