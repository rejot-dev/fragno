import {
  appActionBodySha256,
  appActionRequestSchema,
} from "@fragno-dev/backoffice-api/v0/app-actions";
import {
  backofficeAppInstallationAccessInputSchema,
  backofficeAppInstallationActionsApprovalInputSchema,
  backofficeAppInstallationPageInputSchema,
  type AppInstallationResourceScope,
  type BackofficeApp,
  type BackofficeAppInstallation,
  type BackofficeAppInstallationAccessInput,
  type BackofficeAppInstallationActionsApprovalInput,
  type BackofficeAppInstallationMutationResult,
  type BackofficeAppInstallationPage,
  type BackofficeAppInstallationPageInput,
  backofficeAppLookupInputSchema,
  type BackofficeAppLookupInput,
} from "@fragno-dev/backoffice-api/v0/apps";
import { jsonValueSchema } from "@fragno-dev/backoffice-api/v0/shared/json";
import {
  backofficeContextScopesEqual,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import type { HookContext } from "@fragno-dev/db";

import { requireBackofficeContextScopeFromDurableObjectId } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  appInstallationReaches,
  type AppInstallationOwner,
  backofficeAppInstallationClaimInputSchema,
  backofficeAppInstallationInputSchema,
  effectiveAppActions,
  effectiveGrantedPermissions,
  type AppEndpointCallInput,
  type AppEndpointResponse,
  type BackofficeAppConnection,
  type BackofficeAppInstallationClaimInput,
  type BackofficeAppInstallationClaimResult,
  type BackofficeAppInstallationInput,
  type BackofficeAppInstallationsCommands,
  type StoredAppInstallation,
} from "@/fragno/app-installations/contracts";
import type { AppInstallationChangedPayload } from "@/fragno/app-installations/definition";
import type { AppInstallationsFragment } from "@/fragno/app-installations/fragment";
import { createAppInstallationsServer } from "@/fragno/app-installations/server";
import {
  BackofficeAppDomainError,
  runBackofficeAppOperation,
  type BackofficeAppOperationResult,
} from "@/fragno/apps/errors";
import {
  appConnectionName,
  appConnectionState,
  encodeAppConnectionId,
} from "@/fragno/runtime-tools/families/integrations/app-integration";
import { recordIntegrationConnectionState } from "@/fragno/runtime-tools/families/integrations/integration-events";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";

/**
 * How long a first-party installation reuses its app's registration. Authority reads the
 * installation on every check the app makes, so a changed request takes effect within this long.
 */
const REGISTERED_APP_REUSE_MS = 60_000;

/** Owner-scoped behavior shared by Cloudflare and file-backed SQLite. */
export class InMemoryAppInstallationsObject
  extends RpcTarget
  implements BackofficeAppInstallationsCommands
{
  readonly #host: FragmentDurableObjectHost<void, AppInstallationsFragment>;
  readonly #runtime: BackofficeRuntimeServices;
  readonly #owner: AppInstallationOwner;
  readonly #fetch: typeof fetch;
  readonly #nowEpochMs: () => number;
  readonly #registeredApps = new Map<string, { app: BackofficeApp; readAtEpochMs: number }>();
  #fragment: AppInstallationsFragment | null = null;

  constructor({
    state,
    runtime,
    implementation,
    fetch: fetchImpl = fetch,
    nowEpochMs = Date.now,
  }: {
    state: BackofficeObjectState;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    /** Reaches app action endpoints; tests substitute an in-process app. */
    fetch?: typeof fetch;
    nowEpochMs?: () => number;
  }) {
    super();
    this.#nowEpochMs = nowEpochMs;
    // workerd rejects the global fetch when it is invoked as a method of this object.
    this.#fetch = (input, init) => fetchImpl(input, init);
    const scope = requireBackofficeContextScopeFromDurableObjectId(state.id, "APP_INSTALLATIONS");
    if (scope.kind !== "org" && scope.kind !== "user") {
      throw new Error("Backoffice app installation objects require an organization or user scope.");
    }
    const owner = scope;
    this.#runtime = runtime;
    this.#owner = owner;
    this.#host = implementation.createFragmentHost({
      name: "AppInstallations",
      createRuntime: () =>
        createAppInstallationsServer(implementation.fragmentDatabase, {
          owner,
          onInstallationChanged: (payload, context) =>
            this.#recordConnectionStates(payload, context),
        }),
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

  /** Reports each affected scope's connection state as it is once the change committed. */
  async #recordConnectionStates(
    { appId, scopes }: AppInstallationChangedPayload,
    context: HookContext,
  ) {
    if (!this.#runtime.config.bindings.automations) {
      return;
    }
    const app = await this.#getRegisteredApp(appId);
    const connection = await this.getAppConnection({ appId });
    const label = {
      name: await appConnectionName(this.#runtime, app),
      authMethod: "app-installation",
    } as const;
    for (const scope of scopes) {
      const state = appConnectionState(connection, scope);
      await recordIntegrationConnectionState(
        this.#runtime.objects.automations.for(scope).commands,
        {
          id: `${context.hookId.toString()}:${scope.kind === "project" ? scope.projectId : scope.kind}`,
          scope,
          service: "app",
          connectionId: encodeAppConnectionId(app.slug),
          ...(state === "disconnected" ? { state } : { state, label }),
          occurredAt: context.createdAt,
        },
        { propagationContext: context.capturePropagationContext() },
      );
    }
  }

  /** Changes to an installation review the registration as it is now. */
  async #getRegisteredApp(appId: string): Promise<BackofficeApp> {
    const app = await this.#runtime.objects.apps.singleton().commands.getApp({ appId });
    if (!app) {
      throw new BackofficeAppDomainError("APP_NOT_FOUND", "Backoffice app was not found.");
    }
    this.#registeredApps.set(appId, { app, readAtEpochMs: this.#nowEpochMs() });
    return app;
  }

  async #getRecentlyRegisteredApp(appId: string): Promise<BackofficeApp> {
    const reused = this.#registeredApps.get(appId);
    return reused && this.#nowEpochMs() - reused.readAtEpochMs < REGISTERED_APP_REUSE_MS
      ? reused.app
      : await this.#getRegisteredApp(appId);
  }

  /** Only first-party installations read the registry; other grants resolve locally. */
  async #resolveGrants({
    installation,
    grantsFollowApp,
  }: StoredAppInstallation): Promise<BackofficeAppInstallation> {
    if (!grantsFollowApp || installation.status !== "active") {
      return installation;
    }
    const app = await this.#getRecentlyRegisteredApp(installation.appId);
    return {
      ...installation,
      grantedPermissions: effectiveGrantedPermissions(app, installation.grantedPermissions),
    };
  }

  /** Projects live in the owner's automations object; approve only current projects. */
  async #assertProjectsAvailable(resourceScope: AppInstallationResourceScope) {
    if (resourceScope.kind === "owner") {
      return;
    }
    const automations = this.#runtime.objects.automations.for(this.#owner).commands;
    const projects = await Promise.all(
      resourceScope.projectIds.map((projectId) =>
        automations.resolveProjectForExecution({ projectId }),
      ),
    );
    const missing = resourceScope.projectIds.filter((_, index) => projects[index] === null);
    if (missing.length > 0) {
      throw new BackofficeAppDomainError(
        "APP_INSTALLATION_PROJECT_NOT_FOUND",
        `Projects are not available here: ${missing.join(", ")}.`,
      );
    }
  }

  async installApp(
    input: BackofficeAppInstallationInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>> {
    const installation = backofficeAppInstallationInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      // Resolve the registry before opening the local transaction; approval names its revision.
      const app = await this.#getRegisteredApp(installation.appId);
      await this.#assertProjectsAvailable(installation.resourceScope);
      const fragment = this.#getFragment();
      return await fragment.callServices(() => fragment.services.installApp(installation, app));
    });
  }

  async getInstallation(
    input: BackofficeAppLookupInput,
  ): Promise<BackofficeAppInstallation | null> {
    const lookup = backofficeAppLookupInputSchema.parse(input);
    const fragment = this.#getFragment();
    const installation = await fragment.callServices(() =>
      fragment.services.getInstallation(lookup),
    );
    return installation ? await this.#resolveGrants(installation) : null;
  }

  async listInstallations(
    input: BackofficeAppInstallationPageInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationPage>> {
    const page = backofficeAppInstallationPageInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const fragment = this.#getFragment();
      const listed = await fragment.callServices(() => fragment.services.listInstallations(page));
      return {
        ...listed,
        installations: await Promise.all(
          listed.installations.map((installation) => this.#resolveGrants(installation)),
        ),
      };
    });
  }

  async updateInstallationAccess(
    input: BackofficeAppInstallationAccessInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>> {
    const access = backofficeAppInstallationAccessInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const app = await this.#getRegisteredApp(access.appId);
      await this.#assertProjectsAvailable(access.resourceScope);
      const fragment = this.#getFragment();
      return await fragment.callServices(() =>
        fragment.services.updateInstallationAccess(access, app),
      );
    });
  }

  async claimInstallation(
    input: BackofficeAppInstallationClaimInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationClaimResult>> {
    const claim = backofficeAppInstallationClaimInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const fragment = this.#getFragment();
      const { claimed, grantsFollowApp } = await fragment.callServices(() =>
        fragment.services.claimInstallation(claim),
      );
      if (!grantsFollowApp) {
        return claimed;
      }
      const app = await this.#getRecentlyRegisteredApp(claimed.appId);
      return {
        ...claimed,
        grantedPermissions: effectiveGrantedPermissions(app, claimed.grantedPermissions),
      };
    });
  }

  async approveActions(
    input: BackofficeAppInstallationActionsApprovalInput,
  ): Promise<BackofficeAppOperationResult<BackofficeAppInstallationMutationResult>> {
    const approval = backofficeAppInstallationActionsApprovalInputSchema.parse(input);
    return await runBackofficeAppOperation(async () => {
      const app = await this.#getRegisteredApp(approval.appId);
      const fragment = this.#getFragment();
      return await fragment.callServices(() => fragment.services.approveActions(approval, app));
    });
  }

  async getAppConnection(input: BackofficeAppLookupInput): Promise<BackofficeAppConnection> {
    const lookup = backofficeAppLookupInputSchema.parse(input);
    const fragment = this.#getFragment();
    const record = await fragment.callServices(() =>
      fragment.services.getApprovedInstallation(lookup),
    );
    if (record?.installation.status !== "active") {
      return { status: "not-installed" };
    }
    const app = await this.#getRegisteredApp(lookup.appId);
    return {
      status: "installed",
      app,
      installation: record.grantsFollowApp
        ? {
            ...record.installation,
            grantedPermissions: effectiveGrantedPermissions(
              app,
              record.installation.grantedPermissions,
            ),
          }
        : record.installation,
      ...effectiveAppActions(app, record.approvedActions),
    };
  }

  async callAppEndpoint(
    input: AppEndpointCallInput,
  ): Promise<BackofficeAppOperationResult<AppEndpointResponse>> {
    const request = appActionRequestSchema.parse(input.request);
    return await runBackofficeAppOperation(async () => {
      const connection = await this.getAppConnection({ appId: input.appId });
      if (connection.status !== "installed") {
        throw new BackofficeAppDomainError(
          "APP_INSTALLATION_INACTIVE",
          "Backoffice app is not installed by this owner.",
        );
      }
      const { installation, actions } = connection;
      if (
        !backofficeContextScopesEqual(
          backofficeScopeRootOwner(input.scopeRestriction),
          this.#owner,
        ) ||
        !appInstallationReaches(installation, input.scopeRestriction)
      ) {
        throw new BackofficeAppDomainError(
          "APP_INSTALLATION_OUT_OF_SCOPE",
          "Backoffice app installation does not include this scope.",
        );
      }
      if (installation.externalAccount === null) {
        throw new BackofficeAppDomainError(
          "APP_INSTALLATION_UNCLAIMED",
          "Backoffice app has not linked this installation to one of its accounts; finish the app's connect flow.",
        );
      }
      if (
        actions.kind === "none" ||
        (request.type === "action" && !actions.actions.some(({ id }) => id === request.actionId))
      ) {
        throw new BackofficeAppDomainError(
          "APP_ACTION_NOT_FOUND",
          "Backoffice app action is not declared or not approved.",
        );
      }
      const body = JSON.stringify(request);
      const { token } = await this.#runtime.objects.auth.singleton().commands.issueAppActionToken({
        aud: actions.endpointUrl,
        actor: input.actor,
        installation: {
          appId: installation.appId,
          activation: installation.activation,
          externalAccount: installation.externalAccount,
        },
        scopeRestriction: input.scopeRestriction,
        bodySha256: await appActionBodySha256(body),
      });
      let response: Response;
      try {
        response = await this.#fetch(actions.endpointUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body,
        });
      } catch (error) {
        throw new BackofficeAppDomainError(
          "APP_ENDPOINT_UNREACHABLE",
          `Backoffice app endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A non-JSON answer is reported with its status alone.
      }
      const json = jsonValueSchema.safeParse(parsed);
      return { status: response.status, body: json.success ? json.data : null };
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

/**
 * Customer installation grants are resolved and revoked without a registry read, except that a
 * first-party installation reads its app's registration at most once a minute.
 */
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
