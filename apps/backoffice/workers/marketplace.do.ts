import type {
  MarketplacePublishResult,
  MarketplaceListingPageInput,
  MarketplacePublishedListingInput,
  MarketplaceListingDetail,
  MarketplaceFeaturedResult,
  MarketplaceFeatureEntry,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { DurableObject } from "cloudflare:workers";

import type {
  MarketplaceCommands,
  BackofficeActionRpcContext,
} from "@/backoffice-runtime/object-registry";
import type {
  MarketplaceListingPage,
  MarketplaceListingStorageInput,
  MarketplaceListingStorage,
  MarketplaceLatestPublishedVersionsInput,
  MarketplaceLatestPublishedVersions,
  MarketplaceOwnedListingPageInput,
  MarketplaceOwnedListingPage,
  MarketplaceOwnedListingInput,
  MarketplaceOwnedListingDetail,
  MarketplaceFeaturedListing,
  MarketplaceFeatureListingInput,
  MarketplaceOperationResult,
  MarketplaceUnfeatureInput,
  MarketplaceUnfeatureResult,
  MarketplaceInsertStaticEntriesInput,
  MarketplaceInsertStaticEntriesResult,
  MarketplaceCreateDraftListingInput,
  MarketplaceDraftResult,
  MarketplaceAddDraftVersionInput,
  MarketplaceUpdateListingInput,
  MarketplaceListingUpdateResult,
  MarketplacePublishVersionInput,
  MarketplacePublishVersionResult,
  MarketplaceArchiveListingInput,
  MarketplaceArchiveResult,
} from "@/fragno/marketplace/contracts";
import type {
  MarketplacePublishPackageInput,
  MarketplacePublishReleaseInput,
  MarketplacePublishReleaseResult,
  MarketplacePackagePublishRequest,
} from "@/fragno/marketplace/package-publishing";

import type { MarketplaceObject } from "./marketplace-object";

export class Marketplace extends DurableObject<CloudflareEnv> implements MarketplaceCommands {
  #object!: MarketplaceObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { MarketplaceObject } = await import("./marketplace-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new MarketplaceObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  publishPackage(
    input: MarketplacePublishPackageInput,
    context: BackofficeActionRpcContext,
  ): Promise<MarketplacePublishResult> {
    return this.#object.publishPackage(input, context);
  }

  publishRelease(
    input: MarketplacePublishReleaseInput,
    context: BackofficeActionRpcContext,
  ): Promise<MarketplacePublishReleaseResult> {
    return this.#object.publishRelease(input, context);
  }

  beginPackagePublish(
    request: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<"publishing" | "published"> {
    return this.#object.beginPackagePublish(request, context);
  }

  async completePackagePublish(
    request: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<void> {
    const startedAt = performance.now();
    await this.#object.completePackagePublish(request, context);
    const handlerReturnedAt = performance.now();
    let outcome: "returned" | "threw" = "threw";
    try {
      // Targeted diagnostic: expose the durability wait normally hidden behind the RPC
      // output gate. Keep this at the Cloudflare boundary, not in publication domain logic.
      await this.ctx.storage.sync();
      outcome = "returned";
    } finally {
      const finishedAt = performance.now();
      console.info("backoffice.marketplace.publication.storage_sync_finished", {
        workflowInstanceId: request.workflowInstanceId,
        listingId: request.intent.release.listingId,
        version: request.intent.release.version,
        outcome,
        handlerDurationMs: handlerReturnedAt - startedAt,
        storageSyncDurationMs: finishedAt - handlerReturnedAt,
        durationMs: finishedAt - startedAt,
      });
    }
  }

  failPackagePublish(input: {
    listingId: string;
    version: string;
    workflowInstanceId: string;
  }): Promise<void> {
    return this.#object.failPackagePublish(input);
  }

  listPublishedListings(input: MarketplaceListingPageInput = {}): Promise<MarketplaceListingPage> {
    return this.#object.listPublishedListings(input);
  }

  getPublishedListing(
    input: MarketplacePublishedListingInput,
  ): Promise<MarketplaceListingDetail | null> {
    return this.#object.getPublishedListing(input);
  }

  getListingStorage(
    input: MarketplaceListingStorageInput,
  ): Promise<MarketplaceListingStorage | null> {
    return this.#object.getListingStorage(input);
  }

  getLatestPublishedVersions(
    input: MarketplaceLatestPublishedVersionsInput,
  ): Promise<MarketplaceLatestPublishedVersions> {
    return this.#object.getLatestPublishedVersions(input);
  }

  listOwnedListings(input: MarketplaceOwnedListingPageInput): Promise<MarketplaceOwnedListingPage> {
    return this.#object.listOwnedListings(input);
  }

  getOwnedListing(
    input: MarketplaceOwnedListingInput,
  ): Promise<MarketplaceOwnedListingDetail | null> {
    return this.#object.getOwnedListing(input);
  }

  listFeaturedListings(): Promise<{ listings: MarketplaceFeaturedListing[] }> {
    return this.#object.listFeaturedListings();
  }

  listFeatureEntries(): Promise<MarketplaceFeaturedResult> {
    return this.#object.listFeatureEntries();
  }

  featureListing(
    input: MarketplaceFeatureListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceFeatureEntry>> {
    return this.#object.featureListing(input);
  }

  unfeatureListing(
    input: MarketplaceUnfeatureInput,
  ): Promise<MarketplaceOperationResult<MarketplaceUnfeatureResult>> {
    return this.#object.unfeatureListing(input);
  }

  insertStaticEntries(
    input: MarketplaceInsertStaticEntriesInput,
  ): Promise<MarketplaceOperationResult<MarketplaceInsertStaticEntriesResult>> {
    return this.#object.insertStaticEntries(input);
  }

  createDraftListing(
    input: MarketplaceCreateDraftListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceDraftResult>> {
    return this.#object.createDraftListing(input);
  }

  addDraftVersion(
    input: MarketplaceAddDraftVersionInput,
  ): Promise<MarketplaceOperationResult<MarketplaceDraftResult>> {
    return this.#object.addDraftVersion(input);
  }

  updateListing(
    input: MarketplaceUpdateListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceListingUpdateResult>> {
    return this.#object.updateListing(input);
  }

  publishVersion(
    input: MarketplacePublishVersionInput,
  ): Promise<MarketplaceOperationResult<MarketplacePublishVersionResult>> {
    return this.#object.publishVersion(input);
  }

  archiveListing(
    input: MarketplaceArchiveListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceArchiveResult>> {
    return this.#object.archiveListing(input);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  fetch(request: Request): Promise<Response> {
    return this.#object.fetch(request);
  }
}
