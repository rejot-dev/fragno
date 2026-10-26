import type {
  BackofficeAppInstallationMutationResult,
  BackofficeAppLookupInput,
  BackofficeAppInstallation,
  BackofficeAppInstallationPageInput,
  BackofficeAppInstallationPage,
  BackofficeAppInstallationAccessInput,
  BackofficeAppInstallationActionsApprovalInput,
} from "@fragno-dev/backoffice-api/v0/apps";
import { DurableObject } from "cloudflare:workers";

import type {
  BackofficeAppInstallationsCommands,
  BackofficeAppInstallationInput,
  BackofficeAppInstallationClaimInput,
  BackofficeAppInstallationClaimResult,
  BackofficeAppConnection,
  AppEndpointCallInput,
  AppEndpointResponse,
} from "@/fragno/app-installations/contracts";
import type { BackofficeAppOperationResult } from "@/fragno/apps/errors";

import type { AppInstallationsObject } from "./app-installations-object";

/**
 * Customer installation grants are resolved and revoked without a registry read, except that a
 * first-party installation reads its app's registration at most once a minute.
 */
export class AppInstallations
  extends DurableObject<CloudflareEnv>
  implements BackofficeAppInstallationsCommands
{
  #object!: AppInstallationsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { AppInstallationsObject } = await import("./app-installations-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new AppInstallationsObject(
        createCloudflareBackofficeObjectContext(state, env),
      );
    });
  }

  installApp(
    input: BackofficeAppInstallationInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>> {
    return this.#object.installApp(input);
  }

  getInstallation(input: BackofficeAppLookupInput): Promise<BackofficeAppInstallation | null> {
    return this.#object.getInstallation(input);
  }

  listInstallations(
    input: BackofficeAppInstallationPageInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationPage>> {
    return this.#object.listInstallations(input);
  }

  updateInstallationAccess(
    input: BackofficeAppInstallationAccessInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>> {
    return this.#object.updateInstallationAccess(input);
  }

  claimInstallation(
    input: BackofficeAppInstallationClaimInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationClaimResult>> {
    return this.#object.claimInstallation(input);
  }

  approveActions(
    input: BackofficeAppInstallationActionsApprovalInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>> {
    return this.#object.approveActions(input);
  }

  getAppConnection(input: BackofficeAppLookupInput): Promise<BackofficeAppConnection> {
    return this.#object.getAppConnection(input);
  }

  callAppEndpoint(
    input: AppEndpointCallInput,
  ): Promise<BackofficeAppOperationResult<AppEndpointResponse>> {
    return this.#object.callAppEndpoint(input);
  }

  uninstallApp(
    input: BackofficeAppLookupInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>> {
    return this.#object.uninstallApp(input);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  fetch(request: Request): Promise<Response> {
    return this.#object.fetch(request);
  }
}
