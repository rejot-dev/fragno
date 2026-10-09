import type { MarketplacePublishResult } from "@fragno-dev/backoffice-api/v0/marketplace";
import type {
  MarketplaceListingDetail,
  MarketplaceListingPageInput,
  MarketplacePublishedListingInput,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import {
  backofficeExecutionContextSchema,
  deferBackofficeExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type {
  BackofficeActionRpcContext,
  MarketplaceObject,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { listUploadFiles } from "@/file-collection/create-upload-file-collection";
import { getUploadFileSnapshots } from "@/file-collection/get-upload-file-snapshots";
import {
  marketplaceArtifactFileInventoryMatches,
  marketplaceArtifactUploadName,
} from "@/fragno/marketplace/artifacts";
import type {
  MarketplaceAddDraftVersionInput,
  MarketplaceArchiveListingInput,
  MarketplaceArtifactManifest,
  MarketplaceArtifactManifestInput,
  MarketplaceArchiveResult,
  MarketplaceCreateDraftListingInput,
  MarketplaceDraftResult,
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
  MarketplaceUpdateListingInput,
} from "@/fragno/marketplace/contracts";
import { MarketplacePublicationConflictError } from "@/fragno/marketplace/definition";
import { MarketplaceDomainError } from "@/fragno/marketplace/definition";
import type { MarketplaceFragment } from "@/fragno/marketplace/index";
import { createMarketplaceServer } from "@/fragno/marketplace/marketplace";
import {
  marketplacePackageIdentity,
  verifyMarketplacePackageSnapshot,
} from "@/fragno/marketplace/package-manifest";
import {
  assertMarketplacePublicationAuthority,
  marketplacePackagePublishWorkflowInstanceId,
  marketplacePublishPackageInputSchema,
  marketplacePackagePublishRequestSchema,
  marketplacePublishReleaseInputSchema,
  type MarketplacePublishReleaseInput,
  type MarketplacePublishReleaseResult,
  type MarketplacePublishPackageInput,
  type MarketplacePackagePublishRequest,
  type MarketplacePackagePublishIntent,
} from "@/fragno/marketplace/package-publishing";
import {
  captureMarketplaceReleaseSnapshot,
  marketplaceReleaseArtifactFiles,
  verifyMarketplaceReleaseSnapshot,
} from "@/fragno/marketplace/release-snapshot";
import { createUploadRouteCaller } from "@/fragno/upload-server";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";

export class InMemoryMarketplaceObject extends RpcTarget implements MarketplaceObject {
  readonly #host: FragmentDurableObjectHost<void, MarketplaceFragment>;
  #fragment: MarketplaceFragment | null = null;
  readonly #runtime: BackofficeRuntimeServices;

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
    this.#host = implementation.createFragmentHost({
      name: "Marketplace",
      createRuntime: () => createMarketplaceServer(implementation.fragmentDatabase),
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
    const { organizationSlug, slug } = marketplacePackageIdentity(input.snapshot.manifest.name);
    const organization = (
      await this.#runtime.objects.auth.singleton().commands.getAllOrganizations()
    ).find((candidate) => candidate.slug === organizationSlug);
    if (!organization) {
      throw new Error(`Marketplace publisher organization '${organizationSlug}' was not found.`);
    }
    const owner = {
      scope: { kind: "org" as const, orgId: organization.id },
      publisherName: organization.name,
    };
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
      this.#runtime.objects.upload.forName(marketplaceArtifactUploadName(release.listingId)).http,
    );
    const files = await marketplaceReleaseArtifactFiles(release);
    const existing = await listUploadFiles({ routes, provider: "database", prefix: filePrefix });
    if (plan.state === "published") {
      if (
        marketplaceArtifactFileInventoryMatches(
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
      (await getUploadFileSnapshots({ routes, provider: "database", fileKeys })).map((file) => [
        file.fileKey,
        file,
      ]),
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
    await this.#authorizePackagePublish(request, context);
    const uploadName = marketplaceArtifactUploadName(request.intent.release.listingId);
    const filePrefix = `${request.intent.release.version}/`;
    const artifactFiles = await marketplaceReleaseArtifactFiles(request.intent.release);
    const files = await listUploadFiles({
      routes: createUploadRouteCaller(this.#runtime.objects.upload.forName(uploadName).http),
      provider: "database",
      prefix: filePrefix,
      maxPages: 1,
    });
    if (
      !marketplaceArtifactFileInventoryMatches(
        artifactFiles.map((file) => ({
          fileKey: `${filePrefix}${file.relativePath}`,
          sizeBytes: file.sizeBytes,
          checksum: { algo: "sha256" as const, value: file.checksum },
        })),
        files,
      )
    ) {
      throw new MarketplacePublicationConflictError(
        "Marketplace artifact snapshot is incomplete or has different checksums.",
      );
    }
    const fragment = this.#getFragment();
    await fragment.callServices(() => fragment.services.completePackagePublish(request));
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

  async getArtifactManifest(
    input: MarketplaceArtifactManifestInput,
  ): Promise<MarketplaceArtifactManifest | null> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getArtifactManifest(input));
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

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(this.#getFragment(), request);
  }
}

export class Marketplace extends DurableObject<CloudflareEnv> implements MarketplaceObject {
  readonly #object: InMemoryMarketplaceObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryMarketplaceObject(
      createCloudflareBackofficeObjectContext(state, env),
    );
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

  completePackagePublish(
    request: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<void> {
    return this.#object.completePackagePublish(request, context);
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

  getArtifactManifest(
    input: MarketplaceArtifactManifestInput,
  ): Promise<MarketplaceArtifactManifest | null> {
    return this.#object.getArtifactManifest(input);
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
