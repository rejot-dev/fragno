import {
  backofficeAppLookupInputSchema,
  type BackofficeApp,
  type BackofficeAppLookupInput,
} from "@fragno-dev/backoffice-api/v0/apps";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { RpcTarget } from "cloudflare:workers";

import { requireBackofficeContextScopeFromDurableObjectId } from "@/backoffice-runtime/object-registry";
import {
  backofficeAppActionsUpdateInputSchema,
  backofficeAppOAuthClientLookupInputSchema,
  backofficeAppSlugLookupInputSchema,
  backofficeAppPageInputSchema,
  backofficeAppPermissionsUpdateInputSchema,
  backofficeAppRegistrationInputSchema,
  backofficeAppTrustUpdateInputSchema,
  type BackofficeAppActionsUpdateInput,
  type BackofficeAppActionsUpdateResult,
  type BackofficeAppOAuthClientLookupInput,
  type BackofficeAppSlugLookupInput,
  type BackofficeAppPage,
  type BackofficeAppPageInput,
  type BackofficeAppPermissionsUpdateInput,
  type BackofficeAppPermissionsUpdateResult,
  type BackofficeAppRegistrationInput,
  type BackofficeAppRegistrationResult,
  type BackofficeAppsCommands,
  type BackofficeAppTrustUpdateInput,
  type BackofficeAppTrustUpdateResult,
} from "@/fragno/apps/contracts";
import { runBackofficeAppOperation, type BackofficeAppOperationResult } from "@/fragno/apps/errors";
import type { AppsFragment } from "@/fragno/apps/fragment";
import { createAppsServer } from "@/fragno/apps/server";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

/** Singleton registry behavior shared by Cloudflare and the SQLite runtime. */
export class AppsObject extends RpcTarget implements BackofficeAppsCommands {
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

  async updateAppActions(
    input: BackofficeAppActionsUpdateInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppActionsUpdateResult>> {
    const update = backofficeAppActionsUpdateInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const fragment = this.#getFragment();
      return await fragment.callServices(() => fragment.services.updateAppActions(update));
    });
  }

  async updateAppPermissions(
    input: BackofficeAppPermissionsUpdateInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppPermissionsUpdateResult>> {
    const update = backofficeAppPermissionsUpdateInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const fragment = this.#getFragment();
      return await fragment.callServices(() => fragment.services.updateAppPermissions(update));
    });
  }

  async updateAppTrust(
    input: BackofficeAppTrustUpdateInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppTrustUpdateResult>> {
    const update = backofficeAppTrustUpdateInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const fragment = this.#getFragment();
      return await fragment.callServices(() => fragment.services.updateAppTrust(update));
    });
  }

  async listFirstPartyOAuthClientIds(): Promise<string[]> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.listFirstPartyOAuthClientIds());
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

  async getAppBySlug(input: BackofficeAppSlugLookupInput): Promise<BackofficeApp | null> {
    const lookup = backofficeAppSlugLookupInputSchema.parse(input);
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getAppBySlug(lookup));
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
