import type { BackofficeAppLookupInput, BackofficeApp } from "@fragno-dev/backoffice-api/v0/apps";
import { DurableObject } from "cloudflare:workers";

import type {
  BackofficeAppsCommands,
  BackofficeAppRegistrationInput,
  BackofficeAppRegistrationResult,
  BackofficeAppActionsUpdateInput,
  BackofficeAppActionsUpdateResult,
  BackofficeAppPermissionsUpdateInput,
  BackofficeAppPermissionsUpdateResult,
  BackofficeAppTrustUpdateInput,
  BackofficeAppTrustUpdateResult,
  BackofficeAppOAuthClientLookupInput,
  BackofficeAppSlugLookupInput,
  BackofficeAppPageInput,
  BackofficeAppPage,
} from "@/fragno/apps/contracts";
import type { BackofficeAppOperationResult } from "@/fragno/apps/errors";

import type { AppsObject } from "./apps-object";

/** Global app declarations only; customer installation authority is not stored here. */
export class Apps extends DurableObject<CloudflareEnv> implements BackofficeAppsCommands {
  #object!: AppsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { AppsObject } = await import("./apps-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new AppsObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  registerApp(
    input: BackofficeAppRegistrationInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppRegistrationResult>> {
    return this.#object.registerApp(input);
  }

  updateAppActions(
    input: BackofficeAppActionsUpdateInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppActionsUpdateResult>> {
    return this.#object.updateAppActions(input);
  }

  updateAppPermissions(
    input: BackofficeAppPermissionsUpdateInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppPermissionsUpdateResult>> {
    return this.#object.updateAppPermissions(input);
  }

  updateAppTrust(
    input: BackofficeAppTrustUpdateInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppTrustUpdateResult>> {
    return this.#object.updateAppTrust(input);
  }

  listFirstPartyOAuthClientIds(): Promise<string[]> {
    return this.#object.listFirstPartyOAuthClientIds();
  }

  getApp(input: BackofficeAppLookupInput): Promise<BackofficeApp | null> {
    return this.#object.getApp(input);
  }

  getAppByOAuthClientId(input: BackofficeAppOAuthClientLookupInput): Promise<BackofficeApp | null> {
    return this.#object.getAppByOAuthClientId(input);
  }

  getAppBySlug(input: BackofficeAppSlugLookupInput): Promise<BackofficeApp | null> {
    return this.#object.getAppBySlug(input);
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
