import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import { requireBackofficeContextScopeFromDurableObjectId } from "@/backoffice-runtime/object-registry";
import {
  backofficeAppLookupInputSchema,
  backofficeAppOAuthClientLookupInputSchema,
  backofficeAppPageInputSchema,
  backofficeAppRegistrationInputSchema,
  type BackofficeApp,
  type BackofficeAppLookupInput,
  type BackofficeAppOAuthClientLookupInput,
  type BackofficeAppPage,
  type BackofficeAppPageInput,
  type BackofficeAppRegistrationInput,
  type BackofficeAppRegistrationResult,
  type BackofficeAppsCommands,
} from "@/fragno/apps/contracts";
import { runBackofficeAppOperation, type BackofficeAppOperationResult } from "@/fragno/apps/errors";
import type { AppsFragment } from "@/fragno/apps/fragment";
import { createAppsServer } from "@/fragno/apps/server";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";

/** Singleton registry behavior shared by Cloudflare and the SQLite runtime. */
export class InMemoryAppsObject extends RpcTarget implements BackofficeAppsCommands {
  readonly #host: FragmentDurableObjectHost<void, AppsFragment>;
  #fragment: AppsFragment | null = null;

  constructor({
    state,
    implementation,
  }: {
    state: BackofficeObjectState;
    implementation: BackofficeObjectImplementation;
  }) {
    super();
    requireBackofficeContextScopeFromDurableObjectId(state.id, "APPS");
    this.#host = implementation.createFragmentHost({
      name: "Apps",
      createRuntime: () => createAppsServer(implementation.fragmentDatabase),
      onProcessError: (error) => {
        console.error("Apps hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("Apps hook dispatcher initialization failed", error);
      },
    });
    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  #getFragment(): AppsFragment {
    if (!this.#fragment) {
      throw new Error("Backoffice apps registry is unavailable.");
    }
    return this.#fragment;
  }

  async registerApp(
    input: BackofficeAppRegistrationInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppRegistrationResult>> {
    const registration = backofficeAppRegistrationInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const fragment = this.#getFragment();
      return await fragment.callServices(() => fragment.services.registerApp(registration));
    });
  }

  async getApp(input: BackofficeAppLookupInput): Promise<BackofficeApp | null> {
    const lookup = backofficeAppLookupInputSchema.parse(input);
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getApp(lookup));
  }

  async getAppByOAuthClientId(
    input: BackofficeAppOAuthClientLookupInput,
  ): Promise<BackofficeApp | null> {
    const lookup = backofficeAppOAuthClientLookupInputSchema.parse(input);
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getAppByOAuthClientId(lookup));
  }

  async listApps(
    input: BackofficeAppPageInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppPage>> {
    const page = backofficeAppPageInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const fragment = this.#getFragment();
      return await fragment.callServices(() => fragment.services.listApps(page));
    });
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(this.#getFragment(), request);
  }
}

/** Global app declarations only; customer installation authority is not stored here. */
export class Apps extends DurableObject<CloudflareEnv> implements BackofficeAppsCommands {
  readonly #object: InMemoryAppsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryAppsObject(createCloudflareBackofficeObjectContext(state, env));
  }

  registerApp(
    input: BackofficeAppRegistrationInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppRegistrationResult>> {
    return this.#object.registerApp(input);
  }

  getApp(input: BackofficeAppLookupInput): Promise<BackofficeApp | null> {
    return this.#object.getApp(input);
  }

  getAppByOAuthClientId(input: BackofficeAppOAuthClientLookupInput): Promise<BackofficeApp | null> {
    return this.#object.getAppByOAuthClientId(input);
  }

  listApps(
    input: BackofficeAppPageInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppPage>> {
    return this.#object.listApps(input);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  fetch(request: Request): Promise<Response> {
    return this.#object.fetch(request);
  }
}
