import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import type { MarketplaceObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import type {
  MarketplaceAddDraftVersionInput,
  MarketplaceArchiveListingInput,
  MarketplaceArchiveResult,
  MarketplaceCreateDraftListingInput,
  MarketplaceDraftResult,
  MarketplaceListingDetail,
  MarketplaceListingPage,
  MarketplaceListingPageInput,
  MarketplaceListingUpdateResult,
  MarketplaceOwnedListingDetail,
  MarketplaceOwnedListingInput,
  MarketplaceOwnedListingPage,
  MarketplaceOwnedListingPageInput,
  MarketplaceOperationResult,
  MarketplacePublishedListingInput,
  MarketplacePublishVersionInput,
  MarketplacePublishVersionResult,
  MarketplaceUpdateListingInput,
} from "@/fragno/marketplace/contracts";
import { MarketplaceDomainError } from "@/fragno/marketplace/definition";
import type { MarketplaceFragment } from "@/fragno/marketplace/index";
import { createMarketplaceServer } from "@/fragno/marketplace/marketplace";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";

export class InMemoryMarketplaceObject extends RpcTarget implements MarketplaceObject {
  readonly #state: BackofficeObjectState;
  readonly #host: FragmentDurableObjectHost<void, MarketplaceFragment>;
  #fragment: MarketplaceFragment | null = null;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
  }) {
    super();
    this.#state = state;
    this.#host = createFragmentDurableObjectHost({
      name: "Marketplace",
      state,
      env,
      createRuntime: () => createMarketplaceServer({ adapters: runtime.adapters }),
      onProcessError: (error) => {
        console.error("Marketplace hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("Marketplace hook processor disabled", error);
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
    return await this.#host.fetch(this.#getFragment(), request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}

export class Marketplace extends DurableObject<CloudflareEnv> implements MarketplaceObject {
  readonly #object: InMemoryMarketplaceObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryMarketplaceObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  listPublishedListings(input: MarketplaceListingPageInput = {}): Promise<MarketplaceListingPage> {
    return this.#object.listPublishedListings(input);
  }

  getPublishedListing(
    input: MarketplacePublishedListingInput,
  ): Promise<MarketplaceListingDetail | null> {
    return this.#object.getPublishedListing(input);
  }

  listOwnedListings(input: MarketplaceOwnedListingPageInput): Promise<MarketplaceOwnedListingPage> {
    return this.#object.listOwnedListings(input);
  }

  getOwnedListing(
    input: MarketplaceOwnedListingInput,
  ): Promise<MarketplaceOwnedListingDetail | null> {
    return this.#object.getOwnedListing(input);
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
