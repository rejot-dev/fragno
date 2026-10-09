import type {
  AutomationEvent,
  AutomationEventDefinition,
  AutomationEventDefinitionCreateInput,
  AutomationEventDefinitionUpdateInput,
} from "@fragno-dev/backoffice-api/v0/events";
import type {
  MarketplaceIngestionRequestInput,
  MarketplaceIngestionRestartResult,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { marketplaceIngestionRequestInputSchema } from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  backofficeContextScopesEqual,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { InstanceStatus } from "@fragno-dev/workflows/workflow";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  backofficeExecutionContextSchema,
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import {
  BACKOFFICE_INTERNAL_CONTEXT_HEADER,
  BackofficeInternalRequestError,
  verifyAuthorizedBackofficeObjectRequest,
} from "@/backoffice-runtime/internal-object-request";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  backofficeContextScopeFromDurableObjectId,
  backofficeObjectScopeFromContextScope,
  type AutomationsDurableHookFragment,
  type AutomationsObject,
  type BackofficeActionRpcContext,
  type BackofficeRpcContext,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type {
  AutomationFragmentConfig,
  AutomationIngestResult,
  AutomationProjectExecutionTarget,
  MarketplaceIngestionRequestResult,
  StarterAutomationRoutesSeedResult,
} from "@/fragno/automation";
import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";
import {
  createAutomationRouteAuthorityResolver,
  type AutomationRouteAuthorityLookup,
} from "@/fragno/automation/authority";
import type { AutomationSourceReader } from "@/fragno/automation/automation-source";
import { createAutomationsRuntime, type AutomationsRuntime } from "@/fragno/automation/automations";
import type {
  AutomationEventSource,
  AutomationEventSourceInput,
} from "@/fragno/automation/event-sources";
import {
  bindExternalIdentityInputSchema,
  getExternalIdentityBindingInputSchema,
  revokeExternalIdentityInputSchema,
  type BindExternalIdentityInput,
  type BindExternalIdentityResult,
  type GetExternalIdentityBindingInput,
  type ResolveExternalIdentityResult,
  type RevokeExternalIdentityInput,
  type RevokeExternalIdentityResult,
} from "@/fragno/automation/external-identities";
import {
  assertMarketplaceIngestionTargetAccessible,
  assertMarketplaceIngestionTargetBelongsToOrganization,
  resolveMarketplaceIngestionArtifactVersion,
} from "@/fragno/automation/marketplace-ingestions";
import {
  buildMarketplacePackageInstallWorkflowInstanceId,
  MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
} from "@/fragno/automation/marketplace-package-install-identity";
import { MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME } from "@/fragno/automation/marketplace-package-publish-workflow";
import { readBackofficeAutomationSource } from "@/fragno/automation/read-backoffice-automation-source";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";
import { marketplaceArtifactUploadName } from "@/fragno/marketplace/artifacts";
import {
  captureBundledMarketplaceRelease,
  initializeMarketplaceListingRootFiles,
} from "@/fragno/marketplace/bundled-release";
import type {
  MarketplaceStaticPublicationEntryResult,
  MarketplaceStaticPublicationResult,
} from "@/fragno/marketplace/contracts";
import { MarketplaceListingArchivedError } from "@/fragno/marketplace/definition";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import {
  assertMarketplacePublicationAuthority,
  marketplacePackagePublishWorkflowInstanceId,
  marketplacePackagePublishRequestSchema,
  type MarketplacePackagePublishRequest,
} from "@/fragno/marketplace/package-publishing";
import { listStaticMarketplaceEntries } from "@/fragno/marketplace/static-entries";
import { createUploadRouteCaller } from "@/fragno/upload-server";

import type {
  BackofficeFragmentDurableObject,
  BackofficeObjectState,
  BackofficeOutboxItem,
} from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";

type AutomationDurableObjectConfig = {
  scope: BackofficeContextScope;
};

type AutomationsOutboxItem = BackofficeOutboxItem & {
  type: "automations.initialized";
};

function selectAutomationsDurableHookFragment(
  runtime: AutomationsRuntime,
  fragment: AutomationsDurableHookFragment,
) {
  switch (fragment) {
    case "workflows":
      return runtime.workflowsFragment;
    case "automation":
      return runtime.automationFragment;
    default:
      throw new Error("Unsupported Automations durable hook fragment.");
  }
}

const createAutomationsObjectExecution = (
  scope: BackofficeContextScope,
): BackofficeExecutionContext => {
  if (scope.kind === "system") {
    return createBackofficeSystemExecution(scope);
  }
  return createBackofficeServiceExecution({
    scope,
    service: {
      type: "object",
      id: `automations:${backofficeScopePathSegment(scope)}`,
    },
  });
};

const assertAutomationObjectScope = (
  expected: BackofficeContextScope,
  actual: BackofficeContextScope,
) => {
  if (!backofficeContextScopesEqual(expected, actual)) {
    throw new Error("Backoffice object method scope does not match object address scope.");
  }
};

type MarketplaceWorkflowOperation = {
  label: "publication" | "ingestion";
  failedErrorName: "MarketplacePublicationFailed" | "MarketplaceIngestionFailed";
  terminatedErrorName: "MarketplacePublicationTerminated" | "MarketplaceIngestionTerminated";
};

type ExistingMarketplaceWorkflowState =
  | {
      state: "pending";
      workflowStatus: "active" | "waiting" | "paused";
    }
  | {
      state: "failed";
      workflowStatus: "errored" | "terminated";
      error: { name: string; message: string };
    }
  | { state: "complete" };

const describeExistingMarketplaceWorkflow = (input: {
  operation: MarketplaceWorkflowOperation;
  status: InstanceStatus;
  workflowInstanceId: string;
}): ExistingMarketplaceWorkflowState => {
  switch (input.status.status) {
    case "active":
    case "waiting":
    case "paused":
      return {
        state: "pending",
        workflowStatus: input.status.status,
      };
    case "errored":
    case "terminated":
      return {
        state: "failed",
        workflowStatus: input.status.status,
        error: input.status.error ?? {
          name:
            input.status.status === "terminated"
              ? input.operation.terminatedErrorName
              : input.operation.failedErrorName,
          message: `Marketplace ${input.operation.label} workflow ${input.workflowInstanceId} ${input.status.status}.`,
        },
      };
    case "complete":
      return { state: "complete" };
  }

  throw new Error("Unsupported marketplace workflow status.");
};

export class InMemoryAutomationsObject extends RpcTarget implements AutomationsObject {
  readonly #env: AutomationFragmentConfig["env"] | undefined;
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #internalRequestEnv: Pick<CloudflareEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET"> | null;
  readonly #nowEpochMs: () => number;
  readonly #kernel: BackofficeKernel;
  readonly #host: BackofficeFragmentDurableObject<
    AutomationDurableObjectConfig,
    AutomationDurableObjectConfig,
    AutomationsRuntime,
    AutomationsOutboxItem
  >;
  #scope: BackofficeContextScope | null = null;
  private readonly automationRoutePrefix = "/api/automations";

  constructor({
    state,
    env,
    runtime,
    implementation,
    nowEpochMs = Date.now,
    readAutomationSource,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    nowEpochMs?: () => number;
    readAutomationSource?: AutomationSourceReader;
  }) {
    super();
    this.#env = env as AutomationFragmentConfig["env"];
    this.#internalRequestEnv = env
      ? (env as Pick<CloudflareEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">)
      : null;
    this.#state = state;
    this.#runtimeServices = {
      ...runtime,
      authorityResolver: createAutomationRouteAuthorityResolver({
        fallbackResolver: runtime.authorityResolver,
        lookupRoute: async ({ scope, routeId }) => {
          assertAutomationObjectScope(this.#requireScope(), scope);
          return await this.getRouteForAuthority({ id: routeId });
        },
      }),
    };
    this.#nowEpochMs = nowEpochMs;
    this.#kernel = new BackofficeKernel(this.#runtimeServices);
    this.#scope = backofficeContextScopeFromDurableObjectId(state.id, "AUTOMATIONS");
    const automationSourceReader =
      readAutomationSource ??
      (({ execution, path }) =>
        readBackofficeAutomationSource({
          objects: this.#runtimeServices.objects,
          kernel: this.#kernel,
          execution,
          config: this.#runtimeServices.config,
          path,
        }));
    this.#host = implementation.createConfiguredFragmentHost({
      name: "Automations",
      isConfigured: (stored): stored is AutomationDurableObjectConfig => Boolean(stored?.scope),
      createRuntime: (config) =>
        createAutomationsRuntime(implementation.fragmentDatabase, {
          env: this.#env,
          runtime: this.#runtimeServices,
          ownerScope: config.scope,
          kernel: this.#kernel,
          readAutomationSource: automationSourceReader,
        }),
      getMigrationFragments: (runtime) => [runtime.workflowsFragment, runtime.automationFragment],
      hostRuntime: (runtime, { hostFragment }) => ({
        ...runtime,
        workflowsFragment: hostFragment(runtime.workflowsFragment),
        automationFragment: hostFragment(runtime.automationFragment),
      }),
      mounts: [
        {
          id: "automation",
          match: ({ pathname }) =>
            pathname === this.automationRoutePrefix ||
            pathname.startsWith(`${this.automationRoutePrefix}/`),
          target: (runtime) => runtime.automationFragment,
        },
        { id: "workflows", target: (runtime) => runtime.workflowsFragment },
      ],
      outbox: {
        dispatch: async (item) => {
          if (item.type !== "automations.initialized") {
            return;
          }

          const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
          await runtime.automationFragment.callServices(() =>
            runtime.automationFragment.services.seedStarterAutomationRoutes(),
          );
        },
      },
    });

    void state.blockConcurrencyWhile(async () => {
      const stored = await this.#host.loadStored();
      if (!this.#scope && stored) {
        this.#scope = stored.scope;
      } else if (this.#scope && stored) {
        assertAutomationObjectScope(this.#scope, stored.scope);
      }
      await this.#host.initializeFromStored(stored);
      if (stored) {
        await this.#dispatchInitialized(stored.scope);
      }
    });
  }

  #requireScope(): BackofficeContextScope {
    if (!this.#scope) {
      throw new Error("Automations object has not been initialized with scope metadata.");
    }

    return this.#scope;
  }

  async #dispatchInitialized(scope: BackofficeContextScope) {
    await this.#host.dispatch({
      id: `automations.initialized:${
        scope.kind === "system" ? "system" : backofficeScopePathSegment(scope)
      }`,
      type: "automations.initialized",
      createdAt: new Date().toISOString(),
    });
  }

  async #ensureConfigured(config: AutomationDurableObjectConfig | null): Promise<void> {
    if (!config) {
      return;
    }

    const configured = this.#host.getConfigured();
    if (configured) {
      this.#host.assertSameScope(configured.stored, config.scope);
      if (JSON.stringify(configured.stored.scope) === JSON.stringify(config.scope)) {
        return;
      }
    }

    await this.#state.blockConcurrencyWhile(async () => {
      const latest = this.#host.getConfigured();
      if (latest) {
        this.#host.assertSameScope(latest.stored, config.scope);
        if (JSON.stringify(latest.stored.scope) === JSON.stringify(config.scope)) {
          return;
        }
      }
      await this.#host.storeAndInitialize(config);
      await this.#dispatchInitialized(config.scope);
    });
  }

  async #invokeAutomationAction<TResult>({
    context,
    operation,
    resource,
    execute,
  }: {
    context: BackofficeActionRpcContext;
    operation: BackofficePermissionRequirement;
    resource: unknown;
    execute: (runtime: AutomationsRuntime) => Promise<TResult>;
  }): Promise<TResult> {
    const scope = this.#requireScope();
    assertAutomationObjectScope(scope, context.execution.scope);
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await this.#kernel.invoke({
      execution: context.execution,
      operation,
      resource,
      execute: async () => await execute(runtime),
    });
  }

  /** Reads current route authority for trusted runtimes without recursively authorizing the lookup. */
  async getRouteForAuthority(input: { id: string }): ReturnType<AutomationRouteAuthorityLookup> {
    const scope = this.#requireScope();
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const route = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getRoute(input),
    );
    return route ? { enabled: route.enabled, action: route.action } : null;
  }

  async seedStarterAutomationRoutes(): Promise<StarterAutomationRoutesSeedResult> {
    const scope = this.#requireScope();
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.seedStarterAutomationRoutes(),
    );
  }

  async requestMarketplacePackagePublish(
    rawRequest: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<boolean> {
    const request = marketplacePackagePublishRequestSchema.parse(rawRequest);
    const scope = this.#requireScope();
    if (scope.kind !== "system") {
      throw new Error("Marketplace publication requires the System Automations object.");
    }
    const { workflowInstanceId, ...work } = request;
    if (workflowInstanceId !== (await marketplacePackagePublishWorkflowInstanceId(work))) {
      throw new Error(
        "Marketplace publishing workflow identity does not match its captured request.",
      );
    }
    const execution = backofficeExecutionContextSchema.parse(context.execution);
    if (
      !backofficeContextScopesEqual(execution.scope, request.intent.execution.scope) ||
      JSON.stringify(execution.actors) !== JSON.stringify(request.intent.execution.actors) ||
      JSON.stringify(backofficeExecutionScopeRestriction(execution)) !==
        JSON.stringify(request.intent.execution.scopeRestriction)
    ) {
      throw new Error("Marketplace publication must be enqueued by its original publishing actor.");
    }
    await assertMarketplacePublicationAuthority({
      runtime: this.#runtimeServices,
      ...request.intent,
      owner: request.intent.release.owner,
    });
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const created = await runtime.workflowsFragment.callServices(() =>
      runtime.workflowsFragment.services.createBatch(MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME, [
        {
          id: workflowInstanceId,
          params: {
            request,
            metadata: {
              [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: request.intent.execution.actors,
            },
          },
        },
      ]),
    );
    return created.length === 1;
  }

  async requestStaticMarketplacePublications(input?: {
    force?: boolean;
  }): Promise<MarketplaceStaticPublicationResult> {
    const scope = this.#requireScope();
    if (scope.kind !== "system") {
      throw new Error("Static marketplace publication requires the System Automations object.");
    }

    await this.#ensureConfigured({ scope });
    const staticEntries = listStaticMarketplaceEntries();
    const listingIds = staticEntries.map((entry) =>
      marketplaceListingId({ ownerScope: entry.owner.scope, slug: entry.slug }),
    );
    const marketplace = this.#runtimeServices.objects.marketplace.singleton().commands;
    const manifests = new Map(
      await Promise.all(
        Array.from(
          new Set(listingIds),
          async (listingId) =>
            [listingId, await marketplace.getArtifactManifest({ listingId })] as const,
        ),
      ),
    );
    for (const [index, entry] of staticEntries.entries()) {
      if (manifests.get(listingIds[index])?.listingStatus === "archived") {
        throw new MarketplaceListingArchivedError(entry.slug);
      }
    }
    // Skip published entries before encoding bytes, but freeze every selected release before any enqueue.
    const releases = await Promise.all(
      staticEntries.map(async (entry, index) =>
        !input?.force && manifests.get(listingIds[index])?.versions.includes(entry.version)
          ? null
          : captureBundledMarketplaceRelease(entry),
      ),
    );
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const initializedRoots = new Set<string>();
    const publications: MarketplaceStaticPublicationEntryResult[] = Array.from({
      length: staticEntries.length,
    });
    const context = {
      execution: createAutomationsObjectExecution(scope),
      propagationContext: null,
    };
    const groups = new Map<string, number[]>();
    for (const [index, listingId] of listingIds.entries()) {
      const group = groups.get(listingId) ?? [];
      group.push(index);
      groups.set(listingId, group);
    }
    const listingGroups = [...groups.values()];
    // Parallelize independent listings, not releases competing for the same catalog row.
    for (let offset = 0; offset < listingGroups.length; offset += 4) {
      await Promise.all(
        listingGroups.slice(offset, offset + 4).map(async (indices) => {
          for (const index of indices) {
            const release = releases[index];
            const entry = staticEntries[index];
            const identity = {
              listingId: listingIds[index],
              slug: entry.slug,
              version: entry.version,
            };
            if (!release) {
              publications[index] = { ...identity, state: "published" };
              continue;
            }
            const manifest = manifests.get(release.listingId);
            if (
              (!manifest || manifest.versions.length === 0) &&
              !initializedRoots.has(release.listingId)
            ) {
              await initializeMarketplaceListingRootFiles(
                createUploadRouteCaller(
                  this.#runtimeServices.objects.upload.forName(
                    marketplaceArtifactUploadName(release.listingId),
                  ).http,
                ),
                staticEntries[index].rootFiles ?? {},
              );
              initializedRoots.add(release.listingId);
            }
            // Seeding may backfill older versions; version ownership and destination revision guards still apply.
            const result = await marketplace.publishRelease(
              {
                release,
                dryRun: false,
                skipAuthorCheck: release.owner.scope.kind !== "system",
                skipVersionCheck: true,
              },
              context,
            );
            if (result.state === "preview") {
              throw new Error("Marketplace seeding unexpectedly returned a dry-run result.");
            }
            if (result.state === "published") {
              publications[index] = { ...identity, state: "published" };
              continue;
            }
            if (result.workflowCreated) {
              publications[index] = {
                ...identity,
                state: "requested",
                workflowInstanceId: result.workflowInstanceId,
                workflowStatus: "active",
              };
              continue;
            }
            const status = describeExistingMarketplaceWorkflow({
              operation: {
                label: "publication",
                failedErrorName: "MarketplacePublicationFailed",
                terminatedErrorName: "MarketplacePublicationTerminated",
              },
              workflowInstanceId: result.workflowInstanceId,
              status: await runtime.workflowsFragment.callServices(() =>
                runtime.workflowsFragment.services.getInstanceStatus(
                  MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
                  result.workflowInstanceId,
                ),
              ),
            });
            if (status.state === "complete") {
              const published = await marketplace.getArtifactManifest({
                listingId: release.listingId,
              });
              publications[index] = published?.versions.includes(release.version)
                ? { ...identity, state: "published" }
                : {
                    ...identity,
                    state: "failed",
                    workflowInstanceId: result.workflowInstanceId,
                    workflowStatus: "complete",
                    error: {
                      name: "MarketplacePublicationIncomplete",
                      message: `Marketplace publication workflow ${result.workflowInstanceId} completed without publishing ${release.listingId}@${release.version}.`,
                    },
                  };
            } else if (status.state === "pending" && status.workflowStatus === "active") {
              publications[index] = {
                ...identity,
                state: "requested",
                workflowInstanceId: result.workflowInstanceId,
                workflowStatus: "active",
              };
            } else {
              publications[index] = {
                ...identity,
                workflowInstanceId: result.workflowInstanceId,
                ...status,
              };
            }
          }
        }),
      );
    }
    return { publications };
  }

  async requestMarketplaceIngestion(
    rawInput: MarketplaceIngestionRequestInput,
    context: BackofficeActionRpcContext,
  ): Promise<MarketplaceIngestionRequestResult> {
    const scope = this.#requireScope();
    assertAutomationObjectScope(scope, context.execution.scope);
    if (scope.kind !== "org") {
      throw new Error("Marketplace ingestion requires an organization Automations object.");
    }

    const input = marketplaceIngestionRequestInputSchema.parse(rawInput);
    assertMarketplaceIngestionTargetBelongsToOrganization({
      organizationId: scope.orgId,
      targetScope: input.targetScope,
    });

    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    await assertMarketplaceIngestionTargetAccessible({
      organizationId: scope.orgId,
      targetScope: input.targetScope,
      projectExists: async (projectId) =>
        Boolean(
          await runtime.automationFragment.callServices(() =>
            runtime.automationFragment.services.resolveProjectForExecution({ projectId }),
          ),
        ),
      organizationHasMember: async (userId) =>
        await this.#runtimeServices.objects.auth.singleton().commands.hasOrganizationMember({
          organizationId: scope.orgId,
          userId,
        }),
    });

    const resolvedArtifact = resolveMarketplaceIngestionArtifactVersion(
      await this.#runtimeServices.objects.marketplace
        .singleton()
        .commands.getArtifactManifest({ listingId: input.listingId }),
      input.version,
    );
    const version = resolvedArtifact.version;
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      targetScope: input.targetScope,
      installationRoot: input.installationRoot,
      listingId: input.listingId,
      version,
    });
    const identity = {
      listingId: input.listingId,
      version,
      workflowInstanceId,
    };

    const created = await runtime.workflowsFragment.callServices(() =>
      runtime.workflowsFragment.services.createBatch(MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME, [
        {
          id: workflowInstanceId,
          params: {
            ...input,
            version,
            metadata: {
              [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: context.execution.actors,
            },
          },
        },
      ]),
    );
    if (created.length === 1) {
      return { ...identity, state: "requested", workflowStatus: "active" };
    }

    const workflowStatus = describeExistingMarketplaceWorkflow({
      operation: {
        label: "ingestion",
        failedErrorName: "MarketplaceIngestionFailed",
        terminatedErrorName: "MarketplaceIngestionTerminated",
      },
      status: await runtime.workflowsFragment.callServices(() =>
        runtime.workflowsFragment.services.getInstanceStatus(
          MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
          workflowInstanceId,
        ),
      ),
      workflowInstanceId,
    });
    if (workflowStatus.state !== "complete") {
      return { ...identity, ...workflowStatus };
    }

    return { ...identity, state: "ingested" };
  }

  async restartMarketplaceIngestion(
    rawInput: MarketplaceIngestionRequestInput,
    context: BackofficeActionRpcContext,
  ): Promise<MarketplaceIngestionRestartResult> {
    const requested = await this.requestMarketplaceIngestion(rawInput, context);
    if (requested.state === "requested") {
      return {
        listingId: requested.listingId,
        version: requested.version,
        workflowInstanceId: requested.workflowInstanceId,
        action: "created",
        workflowStatus: requested.workflowStatus,
      };
    }

    const input = marketplaceIngestionRequestInputSchema.parse(rawInput);
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const result = await runtime.workflowsFragment.callServices(() =>
      runtime.workflowsFragment.services.restartOrCreateInstance(
        MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
        {
          id: requested.workflowInstanceId,
          create: {
            params: {
              ...input,
              version: requested.version,
              metadata: {
                [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: context.execution.actors,
              },
            },
          },
          restart: {
            precondition: {
              status: { in: ["complete", "errored", "terminated"] },
            },
          },
        },
      ),
    );

    return {
      listingId: requested.listingId,
      version: requested.version,
      workflowInstanceId: requested.workflowInstanceId,
      action: result.action,
      workflowStatus: result.details.status,
    };
  }

  async bindExternalIdentity(
    input: BindExternalIdentityInput,
    context: BackofficeActionRpcContext,
  ): Promise<BindExternalIdentityResult> {
    const parsed = bindExternalIdentityInputSchema.parse(input);

    return await this.#invokeAutomationAction({
      context,
      operation: BACKOFFICE_PERMISSION.identity.bind,
      resource: {
        kind: "external-identity-binding",
        source: parsed.identity.source,
        externalType: parsed.identity.type,
        externalId: parsed.identity.id,
        userId: parsed.userId,
      },
      execute: async (runtime) =>
        await runtime.automationFragment.callServices(
          () => runtime.automationFragment.services.bindExternalIdentity(parsed),
          { propagationContext: context.propagationContext },
        ),
    });
  }

  async revokeExternalIdentity(
    input: RevokeExternalIdentityInput,
    context: BackofficeActionRpcContext,
  ): Promise<RevokeExternalIdentityResult> {
    const parsed = revokeExternalIdentityInputSchema.parse(input);

    return await this.#invokeAutomationAction({
      context,
      operation: BACKOFFICE_PERMISSION.identity.revoke,
      resource: {
        kind: "external-identity-binding",
        source: parsed.identity.source,
        externalType: parsed.identity.type,
        externalId: parsed.identity.id,
        expectedUserId: parsed.expectedUserId,
        expectedVersion: parsed.expectedVersion,
      },
      execute: async (runtime) =>
        await runtime.automationFragment.callServices(
          () => runtime.automationFragment.services.revokeExternalIdentity(parsed),
          { propagationContext: context.propagationContext },
        ),
    });
  }

  async resolveExternalIdentity(
    input: GetExternalIdentityBindingInput,
    context: BackofficeActionRpcContext,
  ): Promise<ResolveExternalIdentityResult> {
    const parsed = getExternalIdentityBindingInputSchema.parse(input);

    return await this.#invokeAutomationAction({
      context,
      operation: BACKOFFICE_PERMISSION.identity.resolve,
      resource: {
        kind: "external-identity-binding",
        source: parsed.identity.source,
        externalType: parsed.identity.type,
        externalId: parsed.identity.id,
      },
      execute: async (runtime) => {
        const binding = await runtime.automationFragment.callServices(
          () => runtime.automationFragment.services.resolveExternalIdentity(parsed),
          { propagationContext: context.propagationContext },
        );
        return binding ? { userId: binding.userId } : null;
      },
    });
  }

  async triggerIngestEvent(
    event: AutomationEvent,
    context?: BackofficeRpcContext,
  ): Promise<AutomationIngestResult> {
    const scope = this.#requireScope();
    assertAutomationObjectScope(scope, event.scope);
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(
      () => runtime.automationFragment.services.ingestEvent(event),
      context,
    );
  }

  async ingestEvent(
    event: AutomationEvent,
    context?: BackofficeRpcContext,
  ): Promise<AutomationIngestResult> {
    return await this.triggerIngestEvent(event, context);
  }

  async listEventSources(): Promise<AutomationEventSource[]> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const sources = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listEventSources(),
    );

    return sources.map((source) => ({
      id: source.id.valueOf(),
      source: source.source,
      label: source.label,
      description: source.description,
      category: source.category,
      createdAt: source.createdAt.toISOString(),
      updatedAt: source.updatedAt.toISOString(),
    }));
  }

  async getEventSource(input: { source: string }): Promise<AutomationEventSource | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const source = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getEventSource(input),
    );

    return source
      ? {
          id: source.id.valueOf(),
          source: source.source,
          label: source.label,
          description: source.description,
          category: source.category,
          createdAt: source.createdAt.toISOString(),
          updatedAt: source.updatedAt.toISOString(),
        }
      : null;
  }

  async ensureEventSource(input: AutomationEventSourceInput): Promise<AutomationEventSource> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.ensureEventSource(input),
    );
  }

  async listEventDefinitions(): Promise<AutomationEventDefinition[]> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    const definitions = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listEventDefinitions(),
    );

    return definitions.map((definition) => ({
      id: definition.id.valueOf(),
      source: definition.source,
      eventType: definition.eventType,
      label: definition.label,
      description: definition.description,
      payloadSchema: definition.payloadSchema,
      actorSchema: definition.actorSchema,
      subjectSchema: definition.subjectSchema,
      example: definition.example,
      enabled: definition.enabled,
      capabilityId: "dynamic",
      createdAt: definition.createdAt.toISOString(),
      updatedAt: definition.updatedAt.toISOString(),
    }));
  }

  async getEventDefinition(input: {
    source: string;
    eventType: string;
  }): Promise<AutomationEventDefinition | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    const definition = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getEventDefinition(input),
    );

    return definition
      ? {
          id: definition.id.valueOf(),
          source: definition.source,
          eventType: definition.eventType,
          label: definition.label,
          description: definition.description,
          payloadSchema: definition.payloadSchema,
          actorSchema: definition.actorSchema,
          subjectSchema: definition.subjectSchema,
          example: definition.example,
          enabled: definition.enabled,
          capabilityId: "dynamic",
          createdAt: definition.createdAt.toISOString(),
          updatedAt: definition.updatedAt.toISOString(),
        }
      : null;
  }

  async createEventDefinition(
    input: AutomationEventDefinitionCreateInput,
  ): Promise<AutomationEventDefinition> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.createEventDefinition(input),
    );
  }

  async updateEventDefinition(
    input: AutomationEventDefinitionUpdateInput,
  ): Promise<AutomationEventDefinition | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.updateEventDefinition(input),
    );
  }

  async resolveProjectForExecution(input: {
    projectId?: string;
    slug?: string;
  }): Promise<AutomationProjectExecutionTarget | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.resolveProjectForExecution(input),
    );
  }

  async getDurableHookQueue(
    fragment: AutomationsDurableHookFragment,
    options?: DurableHookQueueOptions,
  ) {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    return await this.#host.getDurableHookQueue(
      ({ runtime }) => selectAutomationsDurableHookFragment(runtime, fragment),
      options,
    );
  }

  async getDurableHook(fragment: AutomationsDurableHookFragment, hookId: string) {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    return await this.#host.getDurableHook(
      ({ runtime }) => selectAutomationsDurableHookFragment(runtime, fragment),
      hookId,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const scope = this.#requireScope();
    await this.#ensureConfigured({ scope });

    if (!request.headers.has(BACKOFFICE_INTERNAL_CONTEXT_HEADER)) {
      return await this.#host.fetch(request);
    }
    if (!this.#internalRequestEnv) {
      throw new Error("Automations internal request verification is not configured.");
    }

    try {
      const verified = await verifyAuthorizedBackofficeObjectRequest({
        request,
        address: {
          binding: "AUTOMATIONS",
          scope: backofficeObjectScopeFromContextScope(scope),
        },
        env: this.#internalRequestEnv,
        nowEpochMs: this.#nowEpochMs(),
      });
      return await this.#host.fetch(verified.request, {
        propagationContext: verified.context.propagationContext,
        requestContext: verified.context.execution,
      });
    } catch (error) {
      if (error instanceof BackofficeInternalRequestError) {
        return Response.json(
          { code: "INVALID_INTERNAL_CONTEXT", message: error.message },
          { status: 401 },
        );
      }
      throw error;
    }
  }

  async alarm() {
    await this.#host.alarm();
  }
}

export class Automations extends DurableObject<CloudflareEnv> implements AutomationsObject {
  readonly #object: InMemoryAutomationsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryAutomationsObject(
      createCloudflareBackofficeObjectContext(state, env),
    );
  }

  async alarm() {
    await this.#object.alarm();
  }

  async triggerIngestEvent(event: AutomationEvent, context?: BackofficeRpcContext) {
    return await this.#object.triggerIngestEvent(event, context);
  }

  async ingestEvent(event: AutomationEvent, context?: BackofficeRpcContext) {
    return await this.#object.ingestEvent(event, context);
  }

  async getRouteForAuthority(input: { id: string }) {
    return await this.#object.getRouteForAuthority(input);
  }

  async seedStarterAutomationRoutes() {
    return await this.#object.seedStarterAutomationRoutes();
  }

  async requestMarketplacePackagePublish(
    request: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<boolean> {
    return await this.#object.requestMarketplacePackagePublish(request, context);
  }

  async requestStaticMarketplacePublications(input?: { force?: boolean }) {
    return await this.#object.requestStaticMarketplacePublications(input);
  }

  async requestMarketplaceIngestion(
    input: MarketplaceIngestionRequestInput,
    context: BackofficeActionRpcContext,
  ) {
    return await this.#object.requestMarketplaceIngestion(input, context);
  }

  async restartMarketplaceIngestion(
    input: MarketplaceIngestionRequestInput,
    context: BackofficeActionRpcContext,
  ) {
    return await this.#object.restartMarketplaceIngestion(input, context);
  }

  async bindExternalIdentity(
    input: BindExternalIdentityInput,
    context: BackofficeActionRpcContext,
  ) {
    return await this.#object.bindExternalIdentity(input, context);
  }

  async revokeExternalIdentity(
    input: RevokeExternalIdentityInput,
    context: BackofficeActionRpcContext,
  ) {
    return await this.#object.revokeExternalIdentity(input, context);
  }

  async resolveExternalIdentity(
    input: GetExternalIdentityBindingInput,
    context: BackofficeActionRpcContext,
  ) {
    return await this.#object.resolveExternalIdentity(input, context);
  }

  async listEventSources() {
    return await this.#object.listEventSources();
  }

  async getEventSource(input: { source: string }) {
    return await this.#object.getEventSource(input);
  }

  async ensureEventSource(input: AutomationEventSourceInput) {
    return await this.#object.ensureEventSource(input);
  }

  async listEventDefinitions() {
    return await this.#object.listEventDefinitions();
  }

  async getEventDefinition(input: { source: string; eventType: string }) {
    return await this.#object.getEventDefinition(input);
  }

  async createEventDefinition(input: AutomationEventDefinitionCreateInput) {
    return await this.#object.createEventDefinition(input);
  }

  async updateEventDefinition(input: AutomationEventDefinitionUpdateInput) {
    return await this.#object.updateEventDefinition(input);
  }

  async resolveProjectForExecution(input: { projectId?: string; slug?: string }) {
    return await this.#object.resolveProjectForExecution(input);
  }

  async getDurableHookQueue(
    fragment: AutomationsDurableHookFragment,
    options?: DurableHookQueueOptions,
  ) {
    return await this.#object.getDurableHookQueue(fragment, options);
  }

  async getDurableHook(fragment: AutomationsDurableHookFragment, hookId: string) {
    return await this.#object.getDurableHook(fragment, hookId);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
