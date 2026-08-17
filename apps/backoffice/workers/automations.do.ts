import type { PiFragmentConfig } from "@fragno-dev/pi-harness/types";
import type { InstanceStatus } from "@fragno-dev/workflows/workflow";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import {
  backofficeContextScopesEqual,
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  type BackofficeContextScope,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type {
  AutomationsObject,
  BackofficeActionRpcContext,
  BackofficeObjectRegistry,
  BackofficeRpcContext,
} from "@/backoffice-runtime/object-registry";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { backofficeScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import {
  createBackofficeFileSystem,
  createMasterFileSystem,
  createSystemFilesContext,
  emptyStaticFileArtifacts,
  staticFileContributor,
  systemFileContributor,
  type MasterFileSystem,
} from "@/files";
import { tmpFileContributor } from "@/files/contributors/tmp";
import type {
  AutomationEvent,
  AutomationEventDefinition,
  AutomationEventDefinitionCreateInput,
  AutomationEventDefinitionUpdateInput,
  AutomationFragmentConfig,
  AutomationIngestResult,
  AutomationProjectExecutionTarget,
  MarketplaceIngestionListInput,
  MarketplaceIngestionLookupInput,
  MarketplaceIngestionRecord,
  MarketplaceIngestionRequestInput,
  MarketplaceIngestionRequestResult,
  MarketplaceIngestionRestartResult,
  SandboxInstanceRecord,
  SandboxInstanceRequestInput,
  SandboxProvider,
  StarterAutomationRoutesSeedResult,
} from "@/fragno/automation";
import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";
import { createAutomationsRuntime, type AutomationsRuntime } from "@/fragno/automation/automations";
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
  buildMarketplaceIngestionWorkflowInstanceId,
  MARKETPLACE_INGEST_WORKFLOW_NAME,
} from "@/fragno/automation/marketplace-ingest-identity";
import {
  assertMarketplaceIngestionTargetAccessible,
  assertMarketplaceIngestionTargetBelongsToOrganization,
  marketplaceIngestionRequestInputSchema,
  resolveMarketplaceIngestionArtifactVersion,
} from "@/fragno/automation/marketplace-ingestions";
import {
  buildMarketplacePublicationWorkflowInstanceId,
  MARKETPLACE_PUBLISH_WORKFLOW_NAME,
} from "@/fragno/automation/marketplace-publish-workflow";
import {
  createPiOperationBillingEvent,
  PiOperationBillingEventValidationError,
} from "@/fragno/billing/pi";
import type { DurableHookQueueOptions, DurableHookQueueResponse } from "@/fragno/durable-hooks";
import type { MarketplaceStaticArtifactEntry } from "@/fragno/marketplace/artifacts";
import type {
  MarketplaceStaticPublicationEntryResult,
  MarketplaceStaticPublicationResult,
} from "@/fragno/marketplace/contracts";
import { MarketplaceListingArchivedError } from "@/fragno/marketplace/definition";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import { listStaticMarketplaceEntries } from "@/fragno/marketplace/static-entries";
import { compareMarketplaceVersions } from "@/fragno/marketplace/version";
import {
  createPiCodemodeRuntime,
  createUnavailablePiCodemodeRuntime,
} from "@/fragno/pi/pi-codemode";
import { PI_SUPPORTED_MODELS, type PiApiKeys, type PiRuntimeState } from "@/fragno/pi/pi-shared";
import type { PiRuntime } from "@/fragno/runtime-tools/families/pi-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createCloudflareSandboxProvider } from "@/sandbox/cloudflare-sandbox-provider";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "@/sandbox/contracts";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
  type BackofficeObjectState,
  type BackofficeOutboxItem,
} from "./lib/backoffice-fragment-durable-object";
import { cloudflareDatabaseTransactionInstrumentation } from "./lib/cloudflare-database-transaction-instrumentation";

export type AutomationsFileSystemResolver = (input: {
  execution: BackofficeExecutionContext;
  purpose?: string;
}) => Promise<MasterFileSystem>;

type AutomationDurableObjectConfig = {
  scope: BackofficeContextScope;
};

type AutomationsOutboxItem = BackofficeOutboxItem & {
  type: "automations.initialized";
};

type AutomationsHookFragment = "automation" | "pi" | "workflows";

const piApiKeys = (env?: CloudflareEnv): PiApiKeys => ({
  openai: env?.OPENAI_API_KEY,
  anthropic: env?.ANTHROPIC_API_KEY,
  gemini: env?.GEMINI_API_KEY,
});

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
      id: `automations:${backofficeScopeSinglePathSegment(scope)}`,
    },
  });
};

const buildPiRuntimeState = (env?: CloudflareEnv): PiRuntimeState => {
  const apiKeys = piApiKeys(env);
  const modelCatalog = PI_SUPPORTED_MODELS.filter((option) => Boolean(apiKeys[option.provider]));
  return { configured: modelCatalog.length > 0, modelCatalog };
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

type StaticMarketplacePublicationRequest = {
  entry: Pick<MarketplaceStaticArtifactEntry, "owner" | "slug" | "version">;
  listingId: string;
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

export const createDefaultAutomationFileSystem = async ({
  objects,
  kernel,
  execution,
  automationHookQueue,
  config,
}: {
  objects: BackofficeObjectRegistry;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  automationHookQueue?: (opts?: DurableHookQueueOptions) => Promise<DurableHookQueueResponse>;
  config: BackofficeRuntimeServices["config"];
}): Promise<MasterFileSystem> => {
  if (
    execution.scope.kind === "org" ||
    execution.scope.kind === "project" ||
    (execution.scope.kind === "user" && config.bindings.upload)
  ) {
    return createBackofficeFileSystem({
      objects,
      kernel,
      execution,
      ...(automationHookQueue ? { automationHookQueue } : {}),
      config,
    });
  }

  return createMasterFileSystem(
    createSystemFilesContext({
      objects,
      execution,
      staticFileArtifacts: emptyStaticFileArtifacts,
    }),
    { contributors: [staticFileContributor, systemFileContributor, tmpFileContributor] },
  );
};

export class InMemoryAutomationsObject extends RpcTarget implements AutomationsObject {
  readonly #env: AutomationFragmentConfig["env"] | undefined;
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #kernel: BackofficeKernel;
  readonly #host: BackofficeFragmentDurableObject<
    AutomationDurableObjectConfig,
    AutomationDurableObjectConfig,
    AutomationsRuntime,
    AutomationsOutboxItem
  >;
  readonly #getAutomationFileSystem?: AutomationsFileSystemResolver;
  readonly #createPiRuntime?: (execution: BackofficeExecutionContext) => PiRuntime;
  readonly #sessionFileSystems = new Map<string, Promise<MasterFileSystem>>();
  #scope: BackofficeContextScope | null = null;
  private readonly automationRoutePrefix = "/api/automations";

  constructor({
    state,
    env,
    runtime,
    getAutomationFileSystem,
    createPiRuntime,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
    getAutomationFileSystem?: AutomationsFileSystemResolver;
    createPiRuntime?: (execution: BackofficeExecutionContext) => PiRuntime;
  }) {
    super();
    this.#env = env as AutomationFragmentConfig["env"];
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#kernel = new BackofficeKernel(runtime);
    this.#getAutomationFileSystem = getAutomationFileSystem;
    this.#createPiRuntime = createPiRuntime;
    this.#host = createBackofficeFragmentDurableObject({
      name: "Automations",
      state,
      env,
      isConfigured: (stored): stored is AutomationDurableObjectConfig => Boolean(stored?.scope),
      createRuntime: (config) =>
        createAutomationsRuntime(
          {
            adapters: this.#runtimeServices.adapters,
            transactionInstrumentation: cloudflareDatabaseTransactionInstrumentation,
          },
          {
            env: this.#env,
            runtime: this.#runtimeServices,
            ownerScope: config.scope,
            sandboxProviders: this.#env?.SANDBOX
              ? {
                  [CLOUDFLARE_SANDBOX_PROVIDER]: createCloudflareSandboxProvider({
                    sandboxNamespace: this.#env.SANDBOX,
                    sdk: {
                      async getSandbox(namespace, id, options) {
                        const { getSandbox } = await import("@cloudflare/sandbox");
                        return getSandbox(namespace, id, options);
                      },
                    },
                  }),
                }
              : undefined,
            kernel: this.#kernel,
            pi: this.#createPiRuntimeOptions(config.scope),
            getAutomationFileSystem: async ({ execution, purpose }) => {
              if (this.#getAutomationFileSystem) {
                return await this.#getAutomationFileSystem({ execution, purpose });
              }

              return await this.#createAutomationFileSystem(execution);
            },
          },
        ),
      getMigrationFragments: (runtime) => [
        runtime.workflowsFragment,
        runtime.automationFragment,
        runtime.piFragment,
      ],
      hostRuntime: (runtime, { hostFragment }) => ({
        ...runtime,
        workflowsFragment: hostFragment(runtime.workflowsFragment),
        automationFragment: hostFragment(runtime.automationFragment),
        piFragment: hostFragment(runtime.piFragment),
      }),
      mounts: [
        {
          id: "automation",
          match: ({ pathname }) =>
            pathname === this.automationRoutePrefix ||
            pathname.startsWith(`${this.automationRoutePrefix}/`),
          target: (runtime) => runtime.automationFragment,
        },
        {
          id: "pi",
          match: ({ pathname }) => pathname === "/api/pi" || pathname.startsWith("/api/pi/"),
          target: (runtime) => runtime.piFragment,
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
      await this.#host.initializeFromStored(stored);
      if (stored) {
        await this.#dispatchInitialized(stored.scope);
      }
    });
  }

  init(scope: BackofficeContextScope): AutomationsObject {
    if (this.#scope) {
      assertAutomationObjectScope(this.#scope, scope);
      return this;
    }

    this.#scope = scope;
    return this;
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
        scope.kind === "system" ? "system" : backofficeScopeSinglePathSegment(scope)
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

  async #createAutomationFileSystem(execution: BackofficeExecutionContext) {
    const automationHookObject = this.#kernel.scoped(
      "AUTOMATIONS",
      execution.scope,
      this.#runtimeServices.objects.automations,
    );

    return createDefaultAutomationFileSystem({
      objects: this.#runtimeServices.objects,
      kernel: this.#kernel,
      execution,
      config: this.#runtimeServices.config,
      automationHookQueue: async (opts) =>
        await (
          await automationHookObject.getDurableHookRepository("automation")
        ).getHookQueue(opts),
    });
  }

  #createPiRuntimeOptions(scope: BackofficeContextScope) {
    const execution = createAutomationsObjectExecution(scope);

    return {
      apiKeys: piApiKeys(this.#env),
      sessionFileSystems: this.#sessionFileSystems,
      sessionFileSystemContext: {
        scope,
        objects: this.#runtimeServices.objects,
        kernel: this.#kernel,
        execution,
        runtimeConfig: this.#runtimeServices.config,
      },
      codemode: this.#env
        ? createPiCodemodeRuntime(this.#env)
        : createUnavailablePiCodemodeRuntime(),
      createRuntime: this.#createPiRuntime,
      createRuntimeToolContext: (sessionExecution: BackofficeExecutionContext, pi: PiRuntime) =>
        createRouteBackedRuntimeContext({
          runtime: this.#runtimeServices,
          kernel: this.#kernel,
          execution: sessionExecution,
          pi: { runtime: pi },
        }),
      onOperationCompleted: async (
        payload: Parameters<typeof createPiOperationBillingEvent>[0]["payload"],
        context: Parameters<NonNullable<PiFragmentConfig["onOperationCompleted"]>>[1],
      ) => {
        let event: ReturnType<typeof createPiOperationBillingEvent>;
        try {
          event = createPiOperationBillingEvent({
            scope,
            payload,
            hookId: context.hookId.toString(),
            idempotencyKey: context.idempotencyKey,
          });
        } catch (error) {
          if (error instanceof PiOperationBillingEventValidationError) {
            return;
          }
          throw error;
        }

        if (scope.kind === "org" || scope.kind === "project") {
          await this.#runtimeServices.objects.billing.forOrg(scope.orgId).recordEvent(event, {
            propagationContext: context.capturePropagationContext(),
          });
        }
        // System and user Automations objects have no authoritative organization billing owner.
      },
    };
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

  async seedStarterAutomationRoutes(): Promise<StarterAutomationRoutesSeedResult> {
    const scope = this.#requireScope();
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.seedStarterAutomationRoutes(),
    );
  }

  async requestStaticMarketplacePublications(input?: {
    force?: boolean;
  }): Promise<MarketplaceStaticPublicationResult> {
    const scope = this.#requireScope();
    if (scope.kind !== "org") {
      throw new Error(
        "Static marketplace publication requires an organization Automations object.",
      );
    }

    await this.#ensureConfigured({ scope });
    const forceId = input?.force ? crypto.randomUUID() : undefined;
    const staticEntries = listStaticMarketplaceEntries();
    const entries = staticEntries
      .map((entry) => ({
        entry,
        listingId: marketplaceListingId({ ownerScope: entry.owner.scope, slug: entry.slug }),
      }))
      .sort(
        (left, right) =>
          left.listingId.localeCompare(right.listingId) ||
          compareMarketplaceVersions(left.entry.version, right.entry.version),
      );
    const entriesByListingId = new Map<string, StaticMarketplacePublicationRequest[]>();
    for (const request of entries) {
      const listingEntries = entriesByListingId.get(request.listingId) ?? [];
      listingEntries.push(request);
      entriesByListingId.set(request.listingId, listingEntries);
    }

    const publicationGroups = await Promise.all(
      Array.from(entriesByListingId.values(), (listingEntries) =>
        this.#requestStaticMarketplaceListingPublications(listingEntries, forceId),
      ),
    );
    const results = new Map<string, MarketplaceStaticPublicationEntryResult>();
    for (const publicationGroup of publicationGroups) {
      for (const result of publicationGroup) {
        results.set(result.workflowInstanceId, result);
      }
    }

    return {
      publications: staticEntries.map(({ owner, slug, version }) => {
        const listingId = marketplaceListingId({ ownerScope: owner.scope, slug });
        const workflowInstanceId = buildMarketplacePublicationWorkflowInstanceId({
          listingId,
          version,
          forceId,
        });
        const result = results.get(workflowInstanceId);
        if (!result) {
          throw new Error(`Marketplace publication result ${workflowInstanceId} is missing.`);
        }
        return result;
      }),
    };
  }

  async #requestStaticMarketplaceListingPublications(
    requests: readonly StaticMarketplacePublicationRequest[],
    forceId?: string,
  ): Promise<MarketplaceStaticPublicationEntryResult[]> {
    const [request, ...remainingRequests] = requests;
    if (!request) {
      return [];
    }

    const result = await this.#requestStaticMarketplaceEntryPublication(request.entry, forceId);
    if (result.state !== "published") {
      return [
        result,
        ...remainingRequests.map(({ entry, listingId }) => ({
          listingId,
          slug: entry.slug,
          version: entry.version,
          workflowInstanceId: buildMarketplacePublicationWorkflowInstanceId({
            listingId,
            version: entry.version,
            forceId,
          }),
          state: "queued" as const,
          blockedByVersion: request.entry.version,
        })),
      ];
    }

    return [
      result,
      ...(await this.#requestStaticMarketplaceListingPublications(remainingRequests, forceId)),
    ];
  }

  async #requestStaticMarketplaceEntryPublication(
    entry: Pick<MarketplaceStaticArtifactEntry, "owner" | "slug" | "version">,
    forceId?: string,
  ): Promise<MarketplaceStaticPublicationEntryResult> {
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const listingId = marketplaceListingId({ ownerScope: entry.owner.scope, slug: entry.slug });
    const workflowInstanceId = buildMarketplacePublicationWorkflowInstanceId({
      listingId,
      version: entry.version,
      forceId,
    });
    const marketplace = this.#runtimeServices.objects.marketplace.singleton();
    const manifest = await marketplace.getArtifactManifest({ listingId });
    if (manifest?.listingStatus === "archived") {
      throw new MarketplaceListingArchivedError(entry.slug);
    }

    const published = manifest?.versions.includes(entry.version) ?? false;

    if (published && !forceId) {
      return {
        listingId,
        slug: entry.slug,
        version: entry.version,
        workflowInstanceId,
        state: "published",
      };
    }

    const created = await runtime.workflowsFragment.callServices(() =>
      runtime.workflowsFragment.services.createBatch(MARKETPLACE_PUBLISH_WORKFLOW_NAME, [
        {
          id: workflowInstanceId,
          params: {
            slug: entry.slug,
            version: entry.version,
            publishNextVersions: true,
            forceId,
            metadata: {
              [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: createAutomationsObjectExecution(
                this.#requireScope(),
              ).actors,
            },
          },
        },
      ]),
    );

    const identity = {
      listingId,
      slug: entry.slug,
      version: entry.version,
      workflowInstanceId,
    };
    if (created.length === 1) {
      return {
        ...identity,
        state: "requested",
        workflowStatus: "active",
      };
    }

    const workflowStatus = describeExistingMarketplaceWorkflow({
      operation: {
        label: "publication",
        failedErrorName: "MarketplacePublicationFailed",
        terminatedErrorName: "MarketplacePublicationTerminated",
      },
      status: await runtime.workflowsFragment.callServices(() =>
        runtime.workflowsFragment.services.getInstanceStatus(
          MARKETPLACE_PUBLISH_WORKFLOW_NAME,
          workflowInstanceId,
        ),
      ),
      workflowInstanceId,
    });
    if (workflowStatus.state !== "complete") {
      return { ...identity, ...workflowStatus };
    }

    const completedManifest = await marketplace.getArtifactManifest({ listingId });
    const completedPublication =
      completedManifest?.listingStatus === "published" &&
      completedManifest.versions.includes(entry.version);
    if (completedPublication) {
      return { ...identity, state: "published" };
    }

    return {
      ...identity,
      state: "failed",
      workflowStatus: "complete",
      error: {
        name: "MarketplacePublicationIncomplete",
        message: `Marketplace publication workflow ${workflowInstanceId} completed without publishing ${listingId}@${entry.version}.`,
      },
    };
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
        await this.#runtimeServices.objects.auth.singleton().hasOrganizationMember({
          organizationId: scope.orgId,
          userId,
        }),
    });

    const resolvedArtifact = resolveMarketplaceIngestionArtifactVersion(
      await this.#runtimeServices.objects.marketplace
        .singleton()
        .getArtifactManifest({ listingId: input.listingId }),
      input.version,
    );
    const version = resolvedArtifact.version;
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: input.targetScope,
      listingId: input.listingId,
      version,
    });
    const identity = {
      listingId: input.listingId,
      version,
      workflowInstanceId,
    };

    const existing = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getMarketplaceIngestion({
        targetScope: input.targetScope,
        listingId: input.listingId,
      }),
    );
    if (existing?.version === version) {
      return { ...identity, state: "ingested" };
    }

    const created = await runtime.workflowsFragment.callServices(() =>
      runtime.workflowsFragment.services.createBatch(MARKETPLACE_INGEST_WORKFLOW_NAME, [
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
          MARKETPLACE_INGEST_WORKFLOW_NAME,
          workflowInstanceId,
        ),
      ),
      workflowInstanceId,
    });
    if (workflowStatus.state !== "complete") {
      return { ...identity, ...workflowStatus };
    }

    const completed = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getMarketplaceIngestion({
        targetScope: input.targetScope,
        listingId: input.listingId,
      }),
    );
    if (completed?.version === version) {
      return { ...identity, state: "ingested" };
    }

    return {
      ...identity,
      state: "failed",
      workflowStatus: "complete",
      error: {
        name: "MarketplaceIngestionIncomplete",
        message: `Marketplace ingestion workflow ${workflowInstanceId} completed without recording ${resolvedArtifact.manifest.slug}@${version}.`,
      },
    };
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
      runtime.workflowsFragment.services.restartOrCreateInstance(MARKETPLACE_INGEST_WORKFLOW_NAME, {
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
      }),
    );

    return {
      listingId: requested.listingId,
      version: requested.version,
      workflowInstanceId: requested.workflowInstanceId,
      action: result.action,
      workflowStatus: result.details.status,
    };
  }

  async getMarketplaceIngestion(
    input: MarketplaceIngestionLookupInput,
  ): Promise<MarketplaceIngestionRecord | null> {
    const scope = this.#requireScope();
    if (scope.kind !== "org") {
      throw new Error("Marketplace ingestion requires an organization Automations object.");
    }
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getMarketplaceIngestion(input),
    );
  }

  async listMarketplaceIngestions(
    input?: MarketplaceIngestionListInput,
  ): Promise<MarketplaceIngestionRecord[]> {
    const scope = this.#requireScope();
    if (scope.kind !== "org") {
      throw new Error("Marketplace ingestion requires an organization Automations object.");
    }
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listMarketplaceIngestions(input),
    );
  }

  async fetchWithContext(request: Request, context: BackofficeActionRpcContext): Promise<Response> {
    assertAutomationObjectScope(this.#requireScope(), context.execution.scope);
    await this.#ensureConfigured({ scope: this.#requireScope() });
    return await this.#host.fetch(request, {
      propagationContext: context.propagationContext,
      requestContext: context.execution,
    });
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

  async listSandboxInstances(input?: {
    provider?: SandboxProvider;
    limit?: number;
  }): Promise<SandboxInstanceRecord[]> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listSandboxInstances(input),
    );
  }

  async getSandboxInstance(input: { id: string }): Promise<SandboxInstanceRecord | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getSandboxInstance(input),
    );
  }

  async requestSandboxInstance(input: SandboxInstanceRequestInput): Promise<SandboxInstanceRecord> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const existing = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getSandboxInstance({ id: input.id }),
    );
    if (
      existing &&
      (existing.status === "requested" ||
        existing.status === "starting" ||
        existing.status === "running" ||
        existing.status === "stopping")
    ) {
      return existing;
    }

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.requestSandboxInstance(input),
    );
  }

  async requestSandboxInstanceStop(input: { id: string }): Promise<SandboxInstanceRecord | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const instance = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getSandboxInstance({ id: input.id }),
    );
    const workflowInstanceId = instance?.workflowInstanceId;
    if (!workflowInstanceId) {
      return instance;
    }

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.requestSandboxInstanceStop({
        id: input.id,
        workflowInstanceId,
      }),
    );
  }

  async alarm() {
    await this.#host.alarm();
  }

  async getPiRuntimeState(): Promise<PiRuntimeState> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    return buildPiRuntimeState(this.#env);
  }

  async getDurableHookRepository(fragment?: AutomationsHookFragment) {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    type Options = DurableHookQueueOptions & { fragment?: AutomationsHookFragment };
    return this.#host.getDurableHookRepository<Options>((state, options) => {
      switch (options?.fragment ?? fragment) {
        case "workflows":
          return state.runtime.workflowsFragment;
        case "pi":
          return state.runtime.piFragment;
        case "automation":
        case undefined:
          return state.runtime.automationFragment;
        default:
          throw new Error("Unsupported Automations durable hook fragment.");
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    return await this.#host.fetch(request);
  }
}

export class Automations extends DurableObject<CloudflareEnv> {
  readonly #object: InMemoryAutomationsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryAutomationsObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  init(scope: BackofficeContextScope): AutomationsObject {
    return this.#object.init(scope);
  }

  async alarm() {
    await this.#object.alarm();
  }

  async getPiRuntimeState(): Promise<PiRuntimeState> {
    return await this.#object.getPiRuntimeState();
  }

  async getDurableHookRepository(fragment?: AutomationsHookFragment) {
    return await this.#object.getDurableHookRepository(fragment);
  }

  async fetchWithContext(request: Request, context: BackofficeActionRpcContext): Promise<Response> {
    return await this.#object.fetchWithContext(request, context);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
