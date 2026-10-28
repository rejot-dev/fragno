import {
  marketplaceScopeSchema,
  type MarketplacePublishResult,
  type MarketplaceScope,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import type {
  MarketplaceFeatureEntry,
  MarketplaceFeaturedResult,
  MarketplaceListingDetail,
  MarketplaceListingPageInput,
  MarketplacePublishedListingInput,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { backofficeContextScopesEqual } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { RpcTarget } from "cloudflare:workers";

import { defaultFragnoRuntime } from "@fragno-dev/core";

import {
  backofficeExecutionContextSchema,
  deferBackofficeExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  requireBackofficeContextScopeFromDurableObjectId,
  type BackofficeActionRpcContext,
  type MarketplaceCommands,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { listUploadFiles } from "@/file-collection/create-upload-file-collection";
import { getUploadFileSnapshots } from "@/file-collection/get-upload-file-snapshots";
import type {
  MarketplaceAddDraftVersionInput,
  MarketplaceArchiveListingInput,
  MarketplaceListingStorage,
  MarketplaceListingStorageInput,
  MarketplaceArchiveResult,
  MarketplaceCreateDraftListingInput,
  MarketplaceDraftResult,
  MarketplaceFeaturedListing,
  MarketplaceFeatureListingInput,
  MarketplaceInsertStaticEntriesInput,
  MarketplaceInsertStaticEntriesResult,
  MarketplaceLatestPublishedVersions,
  MarketplaceLatestPublishedVersionsInput,
  MarketplaceListingPage,
  MarketplaceListingUpdateResult,
  MarketplaceOwnedListingDetail,
  MarketplaceOwnedListingInput,
  MarketplaceOwnedListingPage,
  MarketplaceOwnedListingPageInput,
  MarketplaceOperationResult,
  MarketplacePublishVersionInput,
  MarketplacePublishVersionResult,
  MarketplaceUnfeatureInput,
  MarketplaceUnfeatureResult,
  MarketplaceUpdateListingInput,
} from "@/fragno/marketplace/contracts";
import { MarketplacePublicationConflictError } from "@/fragno/marketplace/definition";
import { MarketplaceDomainError } from "@/fragno/marketplace/definition";
import type { MarketplaceFragment } from "@/fragno/marketplace/index";
import { createMarketplaceServer } from "@/fragno/marketplace/marketplace";
import { marketplaceScopeForVisibility } from "@/fragno/marketplace/owner";
import {
  marketplacePackageFileInventoryMatches,
  marketplacePackageUploadName,
} from "@/fragno/marketplace/package-files";
import {
  marketplacePackageIdentity,
  verifyMarketplacePackageSnapshot,
} from "@/fragno/marketplace/package-manifest";
import {
  assertMarketplacePublicationAuthority,
  MarketplacePublicationAccessError,
  marketplacePackagePublishWorkflowInstanceId,
  marketplacePublishPackageInputSchema,
  marketplacePackagePublishRequestSchema,
  marketplacePublishReleaseInputSchema,
  resolveMarketplacePackageOwner,
  type MarketplacePublishReleaseInput,
  type MarketplacePublishReleaseResult,
  type MarketplacePublishPackageInput,
  type MarketplacePackagePublishRequest,
  type MarketplacePackagePublishIntent,
} from "@/fragno/marketplace/package-publishing";
import {
  captureMarketplaceReleaseSnapshot,
  marketplaceReleasePackageFiles,
  verifyMarketplaceReleaseSnapshot,
} from "@/fragno/marketplace/release-snapshot";
import { createUploadRouteCaller } from "@/fragno/upload-server";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

export class MarketplaceObject extends RpcTarget implements MarketplaceCommands {
  readonly #host: FragmentDurableObjectHost<void, MarketplaceFragment>;
  #fragment: MarketplaceFragment | null = null;
  readonly #runtime: BackofficeRuntimeServices;
  readonly #scope: MarketplaceScope;

  constructor({
    state,
    implementation,
    runtime,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
  }) {
    super();
    this.#runtime = runtime;
    const scope = marketplaceScopeSchema.parse(
      requireBackofficeContextScopeFromDurableObjectId(state.id, "MARKETPLACE"),
    );
    this.#scope = scope;
    this.#host = implementation.createFragmentHost({
      name: "Marketplace",
      createRuntime: () =>
        createMarketplaceServer(
          implementation.fragmentDatabase,
          scope,
          // Local runtimes share a controllable clock; deployed objects use real time.
          () => (runtime.fragnoRuntime ?? defaultFragnoRuntime).time.now(),
        ),
      onProcessError: (error) => {
        console.error("Marketplace hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("Marketplace hook dispatcher initialization failed", error);
      },
    });

    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  #getFragment(): MarketplaceFragment {
    if (!this.#fragment) {
      throw new Error("Marketplace is unavailable.");
    }
    return this.#fragment;
  }

  /** Publication work names its Marketplace, so it cannot be committed into another one. */
  #assertMarketplace(marketplace: MarketplaceScope): void {
    if (!backofficeContextScopesEqual(marketplace, this.#scope)) {
      throw new MarketplacePublicationAccessError(
        "Marketplace publication targets a different Marketplace.",
      );
    }
  }

  async publishPackage(
    rawInput: MarketplacePublishPackageInput,
    context: BackofficeActionRpcContext,
  ): Promise<MarketplacePublishResult> {
    const input = marketplacePublishPackageInputSchema.parse(rawInput);
    const execution = backofficeExecutionContextSchema.parse(context.execution);
    if ((input.skipAuthorCheck || input.skipVersionCheck) && execution.scope.kind !== "system") {
      throw new Error("Marketplace publishing overrides require System context.");
    }
    await new BackofficeKernel(this.#runtime).assertAuthorizedAll({
      execution,
      requirements: [
        { operation: BACKOFFICE_PERMISSION.marketplace.publish },
        { operation: BACKOFFICE_PERMISSION.upload.read },
      ],
    });
    const { slug } = marketplacePackageIdentity(input.snapshot.manifest.name);
    const { owner, organization } = await resolveMarketplacePackageOwner(
      this.#runtime.objects,
      input.snapshot.manifest.name,
    );
    this.#assertMarketplace(marketplaceScopeForVisibility(input.visibility, organization));
    await verifyMarketplacePackageSnapshot(input.snapshot);
    const release = await captureMarketplaceReleaseSnapshot({
      owner,
      slug,
      version: input.snapshot.manifest.version,
      metadata: input.snapshot.manifest.metadata,
      files: input.snapshot.files,
    });
    const result = await this.#requestRelease(
      {
        release,
        dryRun: input.dryRun,
        skipAuthorCheck: input.skipAuthorCheck,
        skipVersionCheck: input.skipVersionCheck,
      },
      context,
    );
    const identity = {
      name: input.snapshot.manifest.name,
      listingId: release.listingId,
      version: release.version,
      snapshotId: release.snapshotId,
      owner,
      marketplace: this.#scope,
      files: input.snapshot.files.map(({ relativePath, sizeBytes, checksum }) => ({
        relativePath,
        sizeBytes,
        checksum,
      })),
      sizeBytes: input.snapshot.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    };
    if (result.state === "preview") {
      return { ...identity, state: "preview" };
    }
    return {
      ...identity,
      state: result.state,
      workflowInstanceId: result.workflowInstanceId,
      workflowScope: result.workflowScope,
    };
  }

  async publishRelease(
    rawInput: MarketplacePublishReleaseInput,
    context: BackofficeActionRpcContext,
  ): Promise<MarketplacePublishReleaseResult> {
    const input = marketplacePublishReleaseInputSchema.parse(rawInput);
    await verifyMarketplaceReleaseSnapshot(input.release);
    return this.#requestRelease(input, context);
  }

  async #requestRelease(
    input: MarketplacePublishReleaseInput,
    context: BackofficeActionRpcContext,
  ): Promise<MarketplacePublishReleaseResult> {
    const execution = backofficeExecutionContextSchema.parse(context.execution);
    const { release } = input;
    await new BackofficeKernel(this.#runtime).assertAuthorized({
      execution,
      operation: BACKOFFICE_PERMISSION.upload.read,
    });
    await assertMarketplacePublicationAuthority({
      runtime: this.#runtime,
      execution,
      owner: release.owner,
      skipAuthorCheck: input.skipAuthorCheck,
      skipVersionCheck: input.skipVersionCheck,
    });
    const intent: MarketplacePackagePublishIntent = {
      marketplace: this.#scope,
      release,
      execution: deferBackofficeExecution(execution),
      skipAuthorCheck: input.skipAuthorCheck,
      skipVersionCheck: input.skipVersionCheck,
    };
    const fragment = this.#getFragment();
    const plan = await fragment.callServices(() => fragment.services.planPackagePublish(intent));
    if (input.dryRun) {
      return { state: "preview" };
    }
    if (plan.state === "requested") {
      return {
        state: "requested",
        workflowCreated: false,
        workflowInstanceId: plan.workflowInstanceId,
        workflowScope: { kind: "system" },
      };
    }
    const filePrefix = `${release.version}/`;
    const routes = createUploadRouteCaller(
      this.#runtime.objects.upload.forName(
        marketplacePackageUploadName({ marketplace: this.#scope, listingId: release.listingId }),
      ).http,
    );
    const files = await marketplaceReleasePackageFiles(release);
    const existing = await listUploadFiles({ routes, prefix: filePrefix });
    if (plan.state === "published") {
      if (
        marketplacePackageFileInventoryMatches(
          files.map((file) => ({
            fileKey: `${filePrefix}${file.relativePath}`,
            sizeBytes: file.sizeBytes,
            checksum: { algo: "sha256", value: file.checksum },
          })),
          existing,
        )
      ) {
        return {
          state: "published",
          workflowInstanceId: plan.workflowInstanceId,
          workflowScope: { kind: "system" },
        };
      }
      if (!input.skipVersionCheck) {
        throw new MarketplacePublicationConflictError(
          "Marketplace published files changed. A System version override is required to repair the release.",
        );
      }
    }
    const fileKeys = Array.from(
      new Set([
        ...existing.map((file) => file.fileKey),
        ...files.map((file) => `${filePrefix}${file.relativePath}`),
      ]),
    ).sort();
    const snapshots = new Map(
      (await getUploadFileSnapshots({ routes, fileKeys })).map((file) => [file.fileKey, file]),
    );
    const expectedFiles: MarketplacePackagePublishRequest["expectedFiles"] = fileKeys.map(
      (fileKey) => {
        const file = snapshots.get(fileKey);
        return {
          fileKey,
          precondition:
            file?.status === "ready"
              ? { kind: "revision", revision: file.revision }
              : { kind: "absent" },
        };
      },
    );
    const work = { intent, expectedVersionRevision: plan.expectedVersionRevision, expectedFiles };
    const workflowInstanceId = await marketplacePackagePublishWorkflowInstanceId(work);
    const workflowCreated = await this.#runtime.objects.automations
      .singleton()
      .commands.requestMarketplacePackagePublish({ ...work, workflowInstanceId }, context);
    return {
      state: "requested",
      workflowCreated,
      workflowInstanceId,
      workflowScope: { kind: "system" },
    };
  }

  async beginPackagePublish(
    rawRequest: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<"publishing" | "published"> {
    const request = marketplacePackagePublishRequestSchema.parse(rawRequest);
    await this.#authorizePackagePublish(request, context);
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.beginPackagePublish(request));
  }

  async failPackagePublish(input: {
    listingId: string;
    version: string;
    workflowInstanceId: string;
  }): Promise<void> {
    const fragment = this.#getFragment();
    await fragment.callServices(() => fragment.services.failPackagePublish(input));
  }

  async #authorizePackagePublish(
    request: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<void> {
    this.#assertMarketplace(request.intent.marketplace);
    const coordinator = backofficeExecutionContextSchema.parse(context.execution);
    if (coordinator.scope.kind !== "system") {
      throw new Error("Marketplace publication commit requires System context.");
    }
    await new BackofficeKernel(this.#runtime).assertAuthorized({
      execution: coordinator,
      operation: BACKOFFICE_PERMISSION.marketplace.publish,
    });
    // Deferred authority is checked again without the original request's short-lived token.
    await assertMarketplacePublicationAuthority({
      runtime: this.#runtime,
      ...request.intent,
      owner: request.intent.release.owner,
    });
  }

  async completePackagePublish(
    rawRequest: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<void> {
    const request = marketplacePackagePublishRequestSchema.parse(rawRequest);
    const startedAt = performance.now();
    await this.#authorizePackagePublish(request, context);
    const authorizedAt = performance.now();
    const uploadName = marketplacePackageUploadName({
      marketplace: this.#scope,
      listingId: request.intent.release.listingId,
    });
    const filePrefix = `${request.intent.release.version}/`;
    const packageFiles = await marketplaceReleasePackageFiles(request.intent.release);
    const files = await listUploadFiles({
      routes: createUploadRouteCaller(this.#runtime.objects.upload.forName(uploadName).http),
      prefix: filePrefix,
      maxPages: 1,
    });
    if (
      !marketplacePackageFileInventoryMatches(
        packageFiles.map((file) => ({
          fileKey: `${filePrefix}${file.relativePath}`,
          sizeBytes: file.sizeBytes,
          checksum: { algo: "sha256" as const, value: file.checksum },
        })),
        files,
      )
    ) {
      throw new MarketplacePublicationConflictError(
        "Marketplace package snapshot is incomplete or has different checksums.",
      );
    }
    const fragment = this.#getFragment();
    const inventoryVerifiedAt = performance.now();
    await fragment.callServices(() => fragment.services.completePackagePublish(request));
    const updatedAt = performance.now();
    console.info("backoffice.marketplace.publication.handler_returned", {
      workflowInstanceId: request.workflowInstanceId,
      listingId: request.intent.release.listingId,
      version: request.intent.release.version,
      authorizationDurationMs: authorizedAt - startedAt,
      inventoryDurationMs: inventoryVerifiedAt - authorizedAt,
      updateDurationMs: updatedAt - inventoryVerifiedAt,
      durationMs: updatedAt - startedAt,
    });
  }

  async listPublishedListings(
    input: MarketplaceListingPageInput = {},
  ): Promise<MarketplaceListingPage> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.listPublishedListings(input));
  }

  async getPublishedListing(
    input: MarketplacePublishedListingInput,
  ): Promise<MarketplaceListingDetail | null> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getPublishedListing(input));
  }

  async getListingStorage(
    input: MarketplaceListingStorageInput,
  ): Promise<MarketplaceListingStorage | null> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getListingStorage(input));
  }

  async getLatestPublishedVersions(
    input: MarketplaceLatestPublishedVersionsInput,
  ): Promise<MarketplaceLatestPublishedVersions> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getLatestPublishedVersions(input));
  }

  async listOwnedListings(
    input: MarketplaceOwnedListingPageInput,
  ): Promise<MarketplaceOwnedListingPage> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.listOwnedListings(input));
  }

  async getOwnedListing(
    input: MarketplaceOwnedListingInput,
  ): Promise<MarketplaceOwnedListingDetail | null> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getOwnedListing(input));
  }

  async listFeaturedListings(): Promise<{ listings: MarketplaceFeaturedListing[] }> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.listFeaturedListings());
  }

  async listFeatureEntries(): Promise<MarketplaceFeaturedResult> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.listFeatureEntries());
  }

  async #runOperation<TResult>(
    operation: (fragment: MarketplaceFragment) => Promise<TResult>,
  ): Promise<MarketplaceOperationResult<TResult>> {
    try {
      return { ok: true, value: await operation(this.#getFragment()) };
    } catch (error) {
      if (error instanceof MarketplaceDomainError) {
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        };
      }
      throw error;
    }
  }

  async insertStaticEntries(
    input: MarketplaceInsertStaticEntriesInput,
  ): Promise<MarketplaceOperationResult<MarketplaceInsertStaticEntriesResult>> {
    return await this.#runOperation(
      async (fragment) =>
        await fragment.callServices(() => fragment.services.insertStaticEntries(input)),
    );
  }

  async createDraftListing(
    input: MarketplaceCreateDraftListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceDraftResult>> {
    return await this.#runOperation(
      async (fragment) =>
        await fragment.callServices(() => fragment.services.createDraftListing(input)),
    );
  }

  async addDraftVersion(
    input: MarketplaceAddDraftVersionInput,
  ): Promise<MarketplaceOperationResult<MarketplaceDraftResult>> {
    return await this.#runOperation(
      async (fragment) =>
        await fragment.callServices(() => fragment.services.addDraftVersion(input)),
    );
  }

  async updateListing(
    input: MarketplaceUpdateListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceListingUpdateResult>> {
    return await this.#runOperation(
      async (fragment) => await fragment.callServices(() => fragment.services.updateListing(input)),
    );
  }

  async publishVersion(
    input: MarketplacePublishVersionInput,
  ): Promise<MarketplaceOperationResult<MarketplacePublishVersionResult>> {
    return await this.#runOperation(
      async (fragment) =>
        await fragment.callServices(() => fragment.services.publishVersion(input)),
    );
  }

  async archiveListing(
    input: MarketplaceArchiveListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceArchiveResult>> {
    return await this.#runOperation(
      async (fragment) =>
        await fragment.callServices(() => fragment.services.archiveListing(input)),
    );
  }

  async featureListing(
    input: MarketplaceFeatureListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceFeatureEntry>> {
    return await this.#runOperation(
      async (fragment) =>
        await fragment.callServices(() => fragment.services.featureListing(input)),
    );
  }

  async unfeatureListing(
    input: MarketplaceUnfeatureInput,
  ): Promise<MarketplaceOperationResult<MarketplaceUnfeatureResult>> {
    return await this.#runOperation(
      async (fragment) =>
        await fragment.callServices(() => fragment.services.unfeatureListing(input)),
    );
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(this.#getFragment(), request);
  }
}
