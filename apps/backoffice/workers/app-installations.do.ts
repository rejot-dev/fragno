import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import { requireBackofficeContextScopeFromDurableObjectId } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  backofficeAppInstallationGrantsInputSchema,
  backofficeAppInstallationInputSchema,
  backofficeAppInstallationPageInputSchema,
  type BackofficeAppInstallation,
  type BackofficeAppInstallationGrantsInput,
  type BackofficeAppInstallationInput,
  type BackofficeAppInstallationMutationResult,
  type BackofficeAppInstallationPage,
  type BackofficeAppInstallationPageInput,
  type BackofficeAppInstallationsCommands,
} from "@/fragno/app-installations/contracts";
import type { AppInstallationsFragment } from "@/fragno/app-installations/fragment";
import { createAppInstallationsServer } from "@/fragno/app-installations/server";
import {
  backofficeAppLookupInputSchema,
  type BackofficeAppLookupInput,
} from "@/fragno/apps/contracts";
import {
  BackofficeAppDomainError,
  runBackofficeAppOperation,
  type BackofficeAppOperationResult,
} from "@/fragno/apps/errors";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";

/** Organization-scoped behavior shared by Cloudflare and file-backed SQLite. */
export class InMemoryAppInstallationsObject
  extends RpcTarget
  implements BackofficeAppInstallationsCommands
{
  readonly #host: FragmentDurableObjectHost<void, AppInstallationsFragment>;
  readonly #runtime: BackofficeRuntimeServices;
  #fragment: AppInstallationsFragment | null = null;

  constructor({
    state,
    runtime,
    implementation,
  }: {
    state: BackofficeObjectState;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
  }) {
    super();
    const scope = requireBackofficeContextScopeFromDurableObjectId(state.id, "APP_INSTALLATIONS");
    if (scope.kind !== "org") {
      throw new Error("Backoffice app installation objects require an organization scope.");
    }
    this.#runtime = runtime;
    this.#host = implementation.createFragmentHost({
      name: "AppInstallations",
      createRuntime: () =>
        createAppInstallationsServer(implementation.fragmentDatabase, scope.orgId),
      onProcessError: (error) => {
        console.error("AppInstallations hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("AppInstallations hook dispatcher initialization failed", error);
      },
    });
    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  #getFragment(): AppInstallationsFragment {
    if (!this.#fragment) {
      throw new Error("Backoffice app installations are unavailable.");
    }
    return this.#fragment;
  }

  async #getRegisteredApp(appId: string) {
    const app = await this.#runtime.objects.apps.singleton().commands.getApp({ appId });
    if (!app) {
      throw new BackofficeAppDomainError("APP_NOT_FOUND", "Backoffice app was not found.");
    }
    return app;
  }

  async installApp(
    input: BackofficeAppInstallationInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>> {
    const installation = backofficeAppInstallationInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      // Declarations are immutable. Resolve the registry before opening the local transaction.
      const app = await this.#getRegisteredApp(installation.appId);
      const fragment = this.#getFragment();
      return await fragment.callServices(() =>
        fragment.services.installApp(installation, app.requestedPermissions),
      );
    });
  }

  async getInstallation(
    input: BackofficeAppLookupInput,
  ): Promise<BackofficeAppInstallation | null> {
    const lookup = backofficeAppLookupInputSchema.parse(input);
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getInstallation(lookup));
  }

  async listInstallations(
    input: BackofficeAppInstallationPageInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationPage>> {
    const page = backofficeAppInstallationPageInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const fragment = this.#getFragment();
      return await fragment.callServices(() => fragment.services.listInstallations(page));
    });
  }

  async updateInstallationGrants(
    input: BackofficeAppInstallationGrantsInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>> {
    const grants = backofficeAppInstallationGrantsInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const app = await this.#getRegisteredApp(grants.appId);
      const fragment = this.#getFragment();
      return await fragment.callServices(() =>
        fragment.services.updateInstallationGrants(grants, app.requestedPermissions),
      );
    });
  }

  async uninstallApp(
    input: BackofficeAppLookupInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>> {
    const lookup = backofficeAppLookupInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const fragment = this.#getFragment();
      return await fragment.callServices(() => fragment.services.uninstallApp(lookup));
    });
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(this.#getFragment(), request);
  }
}

/** Customer installation grants are resolved and revoked without a registry read. */
export class AppInstallations
  extends DurableObject<CloudflareEnv>
  implements BackofficeAppInstallationsCommands
{
  readonly #object: InMemoryAppInstallationsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryAppInstallationsObject(
      createCloudflareBackofficeObjectContext(state, env),
    );
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

  updateInstallationGrants(
    input: BackofficeAppInstallationGrantsInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>> {
    return this.#object.updateInstallationGrants(input);
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
