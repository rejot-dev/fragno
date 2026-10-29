import { backofficeScopeJurisdiction } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";

import {
  assertBackofficeObjectAddressAllowed,
  decodeBackofficeObjectScope,
  objectScopeToContextScope,
  type BlobsCommands,
} from "@/backoffice-runtime/object-registry";
import {
  createBlobsServer,
  scopeStorageKeyPrefix,
  type BlobsFragment,
  type BlobsR2Buckets,
} from "@/fragno/blobs-server";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

const BLOBS_NOT_CONFIGURED = "Blobs are not configured: this deployment has no R2 bucket for them.";

/**
 * Records one scope's blobs. Their bytes live under the scope's prefix in the R2 bucket of the
 * scope's jurisdiction, which other scopes share; callers move them through presigned URLs, never
 * through this object.
 */
export class BlobsObject implements BlobsCommands {
  readonly #host: FragmentDurableObjectHost<void, BlobsFragment> | null;
  readonly #initialization: Promise<void>;
  #fragment: BlobsFragment | null = null;

  constructor({
    state,
    implementation,
    storage,
  }: {
    state: BackofficeObjectState & Pick<DurableObjectState, "id">;
    implementation: BackofficeObjectImplementation;
    /** Null when the deployment has no R2 buckets for blobs. */
    storage: { buckets: BlobsR2Buckets; fetch: typeof fetch } | null;
  }) {
    const objectName = state.id.name;
    const scope = objectName ? decodeBackofficeObjectScope(objectName) : null;
    if (!objectName || !scope || scope.kind === "singleton") {
      throw new Error("Blobs Durable Object requires a named, non-singleton identity.");
    }
    assertBackofficeObjectAddressAllowed({ binding: "BLOBS", scope });
    const scopeStorage = storage && {
      bucket:
        storage.buckets[backofficeScopeJurisdiction(objectScopeToContextScope(scope)) ?? "none"],
      fetch: storage.fetch,
    };

    this.#host = scopeStorage
      ? implementation.createFragmentHost({
          name: "Blobs",
          createRuntime: () =>
            createBlobsServer({
              storage: scopeStorage,
              storageKeyPrefix: scopeStorageKeyPrefix(scope, objectName),
              runtime: implementation.fragmentDatabase,
            }),
          onProcessError: (error) => {
            console.error("Blobs hook processor error", error);
          },
          onDispatcherError: (error) => {
            console.warn("Blobs hook dispatcher initialization failed", error);
          },
        })
      : null;
    const host = this.#host;
    this.#initialization = host
      ? state.blockConcurrencyWhile(async () => {
          this.#fragment = await host.initialize(undefined);
        })
      : Promise.resolve();
  }

  #getFragment(): BlobsFragment {
    if (!this.#fragment) {
      throw new Error(BLOBS_NOT_CONFIGURED);
    }
    return this.#fragment;
  }

  async warm(): Promise<void> {
    await this.#initialization;
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    await this.#initialization;
    return await loadDurableHookQueue(this.#getFragment(), options);
  }

  async getDurableHook(hookId: string) {
    await this.#initialization;
    return await loadDurableHook(this.#getFragment(), hookId);
  }

  async wakeDurableHooks() {
    await this.#host?.wake();
  }

  async alarm(): Promise<void> {
    await this.#initialization;
    await this.#host?.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    await this.#initialization;
    if (!this.#host || !this.#fragment) {
      return Response.json(
        { message: BLOBS_NOT_CONFIGURED, code: "NOT_CONFIGURED" },
        { status: 400 },
      );
    }
    return await this.#host.fetch(this.#fragment, request);
  }
}
