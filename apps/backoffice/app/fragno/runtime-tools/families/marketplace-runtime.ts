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
  type MarketplaceScope,
  type MarketplaceViewResult,
  type MarketplaceVisibility,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  marketplaceFeaturedResultSchema,
  type MarketplaceFeatureEntry,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { backofficeScopeOrganization } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type {
  BackofficeObjectRegistry,
  MarketplaceCommands,
} from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import {
  MarketplaceIngestionPackageUnavailableError,
  resolveMarketplaceIngestionPackageVersion,
} from "@/fragno/automation/marketplace-ingestions";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import type {
  MarketplaceOperationResult,
  MarketplaceStaticPublicationResult,
  marketplaceFeatureInputSchema,
  marketplaceUnfeatureInputSchema,
  marketplaceUnfeatureResultSchema,
} from "@/fragno/marketplace/contracts";
import { marketplaceScopeForVisibility } from "@/fragno/marketplace/owner";
import { readMarketplacePackageDeclaration } from "@/fragno/marketplace/package-declaration";
import { captureMarketplacePackageSnapshot } from "@/fragno/marketplace/package-manifest";
import { resolveMarketplacePackageOwner } from "@/fragno/marketplace/package-publishing";
import { searchPublishedListings } from "@/fragno/marketplace/search";

/** Marketplace discovery reads only published registry metadata, never workspace files. */
export type MarketplaceRuntime = {
  search(
    input: z.output<typeof marketplaceSearchInputSchema>,
  ): Promise<z.output<typeof marketplaceSearchResultSchema>>;
  view(input: z.output<typeof marketplaceViewInputSchema>): Promise<MarketplaceViewResult>;
  publish(input: z.output<typeof marketplacePublishInputSchema>): Promise<MarketplacePublishResult>;
  feature(input: z.output<typeof marketplaceFeatureInputSchema>): Promise<MarketplaceFeatureEntry>;
  unfeature(
    input: z.output<typeof marketplaceUnfeatureInputSchema>,
  ): Promise<z.output<typeof marketplaceUnfeatureResultSchema>>;
  featured(): Promise<z.output<typeof marketplaceFeaturedResultSchema>>;
  pushStaticEntries(input: { force?: boolean }): Promise<MarketplaceStaticPublicationResult>;
};

function marketplaceOperationValue<TResult>(result: MarketplaceOperationResult<TResult>): TResult {
  if (result.ok) {
    return result.value;
  }
  throw new BackofficeOperationError(
    result.error.code === "MARKETPLACE_LISTING_NOT_FOUND" ? "not_found" : "conflict",
    result.error.message,
  );
}

/**
 * Discovery reads the public or current organization's Marketplace; publishing targets the package
 * owner's; curation targets the Marketplace the execution scope administers.
 */
export function createMarketplaceRuntime({
  objects,
  execution,
  kernel,
  publication,
}: {
  objects: BackofficeObjectRegistry;
  execution: BackofficeExecutionContext;
  kernel: BackofficeKernel;
  publication: { state: BackofficeStateBackend } | null;
}): MarketplaceRuntime {
  // The organization comes from the execution scope, so callers cannot read another organization's Marketplace.
  function readableMarketplace(visibility: MarketplaceVisibility) {
    if (visibility === "public") {
      return objects.marketplace.singleton().commands;
    }
    const organization = backofficeScopeOrganization(execution.scope);
    if (!organization) {
      throw new BackofficeOperationError(
        "forbidden",
        "Organization Marketplace reads require an organization or project workspace.",
      );
    }
    return objects.marketplace.for(organization).commands;
  }

  /**
   * System administrators curate the public Marketplace from System scope; organization owners and
   * admins curate their organization's Marketplace from its scope.
   */
  async function curate<T>(execute: (marketplace: MarketplaceCommands) => Promise<T>): Promise<T> {
    if (execution.scope.kind === "system") {
      return await kernel.invoke({
        execution,
        operation: BACKOFFICE_PERMISSION.marketplace.feature,
        execute: async () => await execute(objects.marketplace.singleton().commands),
      });
    }
    if (execution.scope.kind === "org") {
      const marketplace: MarketplaceScope = execution.scope;
      return await kernel.invoke({
        execution,
        operation: BACKOFFICE_PERMISSION.org.manage,
        execute: async () => await execute(objects.marketplace.for(marketplace).commands),
      });
    }
    throw new BackofficeOperationError(
      "forbidden",
      "Marketplace curation requires System or organization scope.",
    );
  }

  // Curation records who acted; System executions have no principal.
  const curator = execution.actors.principal
    ? `${execution.actors.principal.type}:${execution.actors.principal.id}`
    : "system";

  return {
    async publish(input) {
      if (!publication) {
        throw new Error("Marketplace publishing is not available in this execution context.");
      }
      if ((input.skipAuthorCheck || input.skipVersionCheck) && execution.scope.kind !== "system") {
        throw new Error("Marketplace publishing overrides require System context.");
      }
      await kernel.assertAuthorizedAll({
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
      const { organization } = await resolveMarketplacePackageOwner(
        objects,
        snapshot.manifest.name,
      );
      const marketplace = marketplaceScopeForVisibility(input.visibility, organization);
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
    async search({ visibility, query, category, pageSize, cursor }) {
      const page = await searchPublishedListings(readableMarketplace(visibility), {
        query,
        category,
        pageSize,
        cursor,
      });
      return {
        listings: page.listings.map((listing) => ({
          listingId: listing.listingId,
          name: listing.name,
          summary: listing.summary,
          publisherName: listing.publisherName,
          category: listing.category,
          tags: listing.tags,
          latestVersion: listing.latestVersion,
          featured: listing.featured,
        })),
        nextCursor: page.nextCursor ?? null,
        hasNextPage: page.hasNextPage,
      };
    },
    async view({ visibility, version, ...input }) {
      const marketplace = readableMarketplace(visibility);
      const [detail, storage] = await Promise.all([
        marketplace.getPublishedListing(input),
        marketplace.getListingStorage({ listingId: input.listingId }),
      ]);
      if (!detail) {
        throw new BackofficeOperationError(
          "not_found",
          `Marketplace listing '${input.listingId}' was not found.`,
        );
      }
      // Resolved as installing resolves it, so the declaration is the one installing approves.
      let release;
      try {
        release = resolveMarketplaceIngestionPackageVersion(storage, version);
      } catch (error) {
        if (error instanceof MarketplaceIngestionPackageUnavailableError) {
          throw new BackofficeOperationError("not_found", error.message);
        }
        throw error;
      }
      const declaration = await readMarketplacePackageDeclaration({
        http: objects.upload.forName(release.manifest.uploadName).http,
        version: release.version,
      });
      return { ...detail, release: { version: release.version, ...declaration } };
    },
    async feature(input) {
      return await curate(async (marketplace) =>
        marketplaceOperationValue(
          await marketplace.featureListing({
            listingId: input.listingId,
            startsAt: input.startsAt === null ? null : new Date(input.startsAt),
            until: input.until === null ? null : new Date(input.until),
            priority: input.priority,
            note: input.note,
            featuredBy: curator,
          }),
        ),
      );
    },
    async unfeature(input) {
      return await curate(async (marketplace) =>
        marketplaceOperationValue(await marketplace.unfeatureListing(input)),
      );
    },
    async featured() {
      return await curate(async (marketplace) => await marketplace.listFeatureEntries());
    },
    async pushStaticEntries(input) {
      return await objects.automations
        .singleton()
        .commands.requestStaticMarketplacePublications(input);
    },
  };
}
