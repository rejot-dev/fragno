import type {
  AutomationEvent,
  AutomationEventDefinition,
  AutomationEventDefinitionUpdateInput,
  AutomationEventRecord,
} from "@fragno-dev/backoffice-api/v0/events";
import type {
  MarketplaceIngestionRequestInput,
  MarketplaceIngestionRestartResult,
  PackageInstallation,
  PackageInstallStatus,
  PackagesImportLegacyInput,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { marketplaceIngestionRequestInputSchema } from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  backofficeContextScopesEqual,
  type BackofficeRoutableScope,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { AcceptedFileShare, FileShare } from "@fragno-dev/backoffice-api/v0/state";
import { type InstanceStatus, WorkflowInstanceNotFoundError } from "@fragno-dev/workflows/workflow";
import { RpcTarget } from "cloudflare:workers";

import { decodeCursor, type Cursor } from "@fragno-dev/db";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
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
  type AutomationsCommands,
  type BackofficeActionRpcContext,
  type BackofficeRpcContext,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { provisionedResourceId } from "@/fragno/apps/provisioned-id";
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
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import { automationEventRecord } from "@/fragno/automation/event-routes";
import type {
  AutomationEventSource,
  AutomationEventSourceInput,
} from "@/fragno/automation/event-sources";
import type { EventDeletionPass } from "@/fragno/automation/events-storage-runtime";
import {
  bindExternalIdentityInputSchema,
  getExternalIdentityBindingInputSchema,
  listExternalIdentityBindingsInputSchema,
  revokeExternalIdentityInputSchema,
  type BindExternalIdentityInput,
  type BindExternalIdentityResult,
  type ExternalIdentityBindingPage,
  type GetExternalIdentityBindingInput,
  type ListExternalIdentityBindingsInput,
  type ResolveExternalIdentityResult,
  type RevokeExternalIdentityInput,
  type RevokeExternalIdentityResult,
} from "@/fragno/automation/external-identities";
import type { AcceptFileShareOutcome } from "@/fragno/automation/file-shares-storage-runtime";
import {
  importLegacyPackageInstallations,
  type LegacyPackageImportOutcome,
} from "@/fragno/automation/legacy-package-installations";
import { AUTOMATION_PAGE_DATABASE_SCHEMA } from "@/fragno/automation/lofi/page-relations";
import {
  assertMarketplaceIngestionTargetAccessible,
  assertMarketplaceIngestionSourceAccessible,
  assertMarketplaceIngestionTargetBelongsToOrganization,
  marketplaceIngestionWorkflowInputSchema,
  resolveMarketplaceIngestionPackageVersion,
} from "@/fragno/automation/marketplace-ingestions";
import {
  buildMarketplacePackageInstallWorkflowInstanceId,
  MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
  marketplaceInstallationWorkflowInstanceId,
} from "@/fragno/automation/marketplace-package-install-identity";
import { MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME } from "@/fragno/automation/marketplace-package-publish-workflow";
import {
  applyPackageInstallation,
  assertPackageInstallationReplaceable,
  uninstallPackage,
  type PackageAutomationsUninstallation,
  type PackageInstallationInput,
  type PackageInstallationOutcome,
} from "@/fragno/automation/package-installations";
import type { PackageInstallationRecord } from "@/fragno/automation/package-installations-storage-runtime";
import { readBackofficeAutomationSource } from "@/fragno/automation/read-backoffice-automation-source";
import { MEMBERS_STEWARD } from "@/fragno/automation/stewards";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";
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
  assertPackagePermissionsApproved,
  readMarketplacePackageDeclaration,
} from "@/fragno/marketplace/package-declaration";
import { marketplacePackageUploadName } from "@/fragno/marketplace/package-files";
import {
  assertMarketplacePublicationAuthority,
  marketplacePackagePublishWorkflowInstanceId,
  marketplacePackagePublishRequestSchema,
  type MarketplacePackagePublishRequest,
} from "@/fragno/marketplace/package-publishing";
import { listStaticMarketplaceEntries } from "@/fragno/marketplace/static-entries";
import {
  ONBOARDING_QUESTIONS,
  ONBOARDING_WORKFLOW_NAME,
  type OnboardingAnswer,
  type OnboardingPrompt,
  type OnboardingQuestion,
  type UserOnboardingState,
} from "@/fragno/onboarding/contracts";
import type { OnboardingWorkflowParams } from "@/fragno/onboarding/onboarding-workflow";
import { createUploadRouteCaller } from "@/fragno/upload-server";

import type {
  BackofficeFragmentDurableObject,
  BackofficeObjectState,
  BackofficeOutboxItem,
} from "./lib/backoffice-fragment-durable-object";
import type {
  BackofficeObjectImplementation,
  SqlQuery,
  SqlQueryCheck,
  SqlQueryChecker,
} from "./lib/backoffice-object-implementation";

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

const MAX_EXTERNAL_IDENTITY_BINDING_PAGE_SIZE = 500;

/**
 * Cursors come back from callers and carry their own page size. The query rejects cursors from
 * another index or direction itself; only the size needs bounding here.
 */
function decodeExternalIdentityBindingCursor(encoded: string): Cursor {
  const cursor = decodeCursor(encoded);
  if (cursor.pageSize > MAX_EXTERNAL_IDENTITY_BINDING_PAGE_SIZE) {
    throw new Error("Cursor is not valid for external identity bindings.");
  }
  return cursor;
}

/**
 * Where a person's onboarding stands, with the round of the question it asks, which numbers that
 * round's answer; or outdated, waiting for an answer no page asks any longer.
 */
type OnboardingReading =
  | Exclude<UserOnboardingState, { status: "asking" }>
  | { status: "asking"; prompt: OnboardingPrompt; round: number }
  | { status: "outdated" };

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

export class AutomationsObject extends RpcTarget implements AutomationsCommands {
  readonly #env: AutomationFragmentConfig["env"] | undefined;
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #internalRequestEnv: Pick<
    BackofficeRuntimeEnv,
    "BACKOFFICE_INTERNAL_REQUEST_SECRET"
  > | null;
  readonly #nowEpochMs: () => number;
  readonly #kernel: BackofficeKernel;
  readonly #checkSqlQueries: SqlQueryChecker;
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
      ? (env as Pick<BackofficeRuntimeEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">)
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
    this.#checkSqlQueries = implementation.checkSqlQueries;
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
          telemetry: implementation.hostTelemetry("Automations"),
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

  /**
   * System's Automations onboard everyone, so a person's scope holds nothing before they choose its
   * jurisdiction.
   */
  async #onboardingRuntime() {
    const scope = this.#requireScope();
    if (scope.kind !== "system") {
      throw new Error("Onboarding runs only in System's Automations.");
    }
    await this.#ensureConfigured({ scope });
    return this.#host.requireConfigured("Automations runtime is not ready.").runtime;
  }

  /**
   * Where a person's onboarding stands: its instance, named by their user ID, records it, with the
   * round of the question it asks, counted from the answers to it the workflow already took. An
   * instance an earlier version of onboarding started may wait for an answer no page asks any
   * longer; it is outdated.
   */
  async #readUserOnboarding(
    runtime: AutomationsRuntime,
    userId: string,
  ): Promise<OnboardingReading> {
    const [status, currentStep, history] = await runtime.workflowsFragment.callServices(() => [
      runtime.workflowsFragment.services.getInstanceStatus(ONBOARDING_WORKFLOW_NAME, userId),
      runtime.workflowsFragment.services.getInstanceCurrentStep(ONBOARDING_WORKFLOW_NAME, userId),
      runtime.workflowsFragment.services.listHistory({
        workflowName: ONBOARDING_WORKFLOW_NAME,
        instanceId: userId,
      }),
    ]);
    switch (status.status) {
      case "complete":
        return { status: "complete" };
      case "errored":
      case "terminated":
        return { status: "failed", message: status.error?.message ?? "Onboarding stopped." };
      case "waiting": {
        const waitEventType = currentStep?.waitEventType ?? null;
        if (waitEventType === null) {
          return { status: "setting-up" };
        }
        const question = (Object.keys(ONBOARDING_QUESTIONS) as OnboardingQuestion[]).find(
          (candidate) => ONBOARDING_QUESTIONS[candidate].event === waitEventType,
        );
        if (!question) {
          return { status: "outdated" };
        }
        const taken = (eventType: string) =>
          history.events.filter(
            ({ type, consumedByStepKey }) => type === eventType && consumedByStepKey !== null,
          );
        // An answer is stored before the workflow takes it, and the instance keeps waiting until
        // then: the question is answered, so setup is under way.
        if (
          history.events.some(
            ({ type, consumedByStepKey }) => type === waitEventType && consumedByStepKey === null,
          )
        ) {
          return { status: "setting-up" };
        }
        const round = taken(waitEventType).length + 1;
        const clients = () =>
          taken(ONBOARDING_QUESTIONS["client-name"].event).map(
            ({ payload }) => ONBOARDING_QUESTIONS["client-name"].schema.parse(payload).name,
          );
        const prompt: OnboardingPrompt =
          question === "client-name"
            ? { question, client: round }
            : question === "more-clients"
              ? { question, clients: clients() }
              : { question };
        return { status: "asking", prompt, round };
      }
      case "active":
      case "paused":
        return { status: "setting-up" };
      default:
        throw new Error("Unsupported onboarding workflow status.", {
          cause: status.status satisfies never,
        });
    }
  }

  /** Starts a person's onboarding, or finds the one they started, and says where it stands. */
  async startUserOnboarding(input: { userId: string }): Promise<UserOnboardingState> {
    const runtime = await this.#onboardingRuntime();
    await runtime.workflowsFragment.callServices(() =>
      runtime.workflowsFragment.services.createBatch(ONBOARDING_WORKFLOW_NAME, [
        { id: input.userId, params: { userId: input.userId } satisfies OnboardingWorkflowParams },
      ]),
    );
    const state = await this.#readUserOnboarding(runtime, input.userId);
    switch (state.status) {
      case "asking":
        return { status: "asking", prompt: state.prompt };
      case "outdated":
        // Starting over loses nothing: the person has not finished, and every step can run again.
        await runtime.workflowsFragment.callServices(() =>
          runtime.workflowsFragment.services.restartInstance(
            ONBOARDING_WORKFLOW_NAME,
            input.userId,
          ),
        );
        return { status: "setting-up" };
      case "setting-up":
      case "complete":
      case "failed":
        return state;
      default:
        throw new Error("Unsupported onboarding state.", { cause: state satisfies never });
    }
  }

  /**
   * Answers the question onboarding asks now, once per round: answering again, or answering a
   * question it no longer asks, as a stale page does, changes nothing. Otherwise a later round of
   * a repeated question would take the stale answer.
   */
  async answerUserOnboarding(input: { userId: string; answer: OnboardingAnswer }): Promise<void> {
    const runtime = await this.#onboardingRuntime();
    const state = await this.#readUserOnboarding(runtime, input.userId);
    if (state.status !== "asking" || state.prompt.question !== input.answer.question) {
      return;
    }
    await runtime.workflowsFragment.callServices(() =>
      runtime.workflowsFragment.services.sendEvent(ONBOARDING_WORKFLOW_NAME, input.userId, {
        // Event IDs are unique across every workflow in System, not per instance.
        id: `${ONBOARDING_WORKFLOW_NAME}:${input.userId}:${input.answer.question}:${state.round}`,
        type: ONBOARDING_QUESTIONS[input.answer.question].event,
        payload: input.answer.answer,
      }),
    );
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
            [listingId, await marketplace.getListingStorage({ listingId })] as const,
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
                    marketplacePackageUploadName({
                      marketplace: { kind: "system" },
                      listingId: release.listingId,
                    }),
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
              const published = await marketplace.getListingStorage({
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
    assertMarketplaceIngestionSourceAccessible({
      organizationId: scope.orgId,
      marketplace: input.marketplace,
    });

    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    await assertMarketplaceIngestionTargetAccessible({
      organizationId: scope.orgId,
      targetScope: input.targetScope,
      // This organization's projects are stored here; any other owner stores its own.
      projectExists: async ({ owner, projectId }) =>
        Boolean(
          backofficeContextScopesEqual(owner, scope)
            ? await runtime.automationFragment.callServices(() =>
                runtime.automationFragment.services.resolveProjectForExecution({ projectId }),
              )
            : await this.#runtimeServices.objects.automations
                .for(owner)
                .commands.resolveProjectForExecution({ projectId }),
        ),
      organizationHasMember: async (userId) =>
        await this.#runtimeServices.objects.auth.singleton().commands.hasOrganizationMember({
          organizationId: scope.orgId,
          userId,
        }),
    });

    const resolvedPackage = resolveMarketplaceIngestionPackageVersion(
      await this.#runtimeServices.objects.marketplace
        .for(input.marketplace)
        .commands.getListingStorage({ listingId: input.listingId }),
      input.version,
    );
    const version = resolvedPackage.version;
    const declaration = await readMarketplacePackageDeclaration({
      http: this.#runtimeServices.objects.upload.forName(resolvedPackage.manifest.uploadName).http,
      version,
    });
    assertPackagePermissionsApproved({
      declared: declaration.permissions,
      approved: input.permissions,
    });
    // An installer can't approve more for a package than they may do themselves.
    await this.#kernel.assertAuthorizedAll({
      execution: context.execution,
      requirements: input.permissions.map((operation) => ({
        operation,
        resource: { kind: "package-installation", listingId: input.listingId },
      })),
    });
    const installed = backofficeContextScopesEqual(input.targetScope, scope)
      ? await runtime.automationFragment.callServices(() =>
          runtime.automationFragment.services.getPackageInstallation({
            listingId: input.listingId,
          }),
        )
      : await this.#runtimeServices.objects.automations
          .for(input.targetScope)
          .commands.getPackageInstallation({ listingId: input.listingId });
    assertPackageInstallationReplaceable(installed, input);
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: input.marketplace,
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

  async getMarketplaceIngestionStatus(input: {
    workflowInstanceId: string;
    targetScope: BackofficeRoutableScope;
  }): Promise<PackageInstallStatus | null> {
    const scope = this.#requireScope();
    if (scope.kind !== "org") {
      throw new Error("Marketplace ingestion requires an organization Automations object.");
    }
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const { services } = runtime.workflowsFragment;
    const unlessMissing = async <T>(read: () => Promise<T>) => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof WorkflowInstanceNotFoundError) {
          return null;
        }
        throw error;
      }
    };

    const ingestion = await unlessMissing(() =>
      runtime.workflowsFragment.callServices(
        () =>
          [
            services.getInstanceStatus(
              MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
              input.workflowInstanceId,
            ),
            services.getInstanceMetadata(
              MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
              input.workflowInstanceId,
            ),
          ] as const,
      ),
    );
    if (!ingestion) {
      return null;
    }
    const [status, metadata] = ingestion;
    const params = marketplaceIngestionWorkflowInputSchema.parse(metadata.params);
    // Other workspaces of this organization install through it too; their runs are theirs to read.
    if (!backofficeContextScopesEqual(params.targetScope, input.targetScope)) {
      return null;
    }
    const installerInstanceId = marketplaceInstallationWorkflowInstanceId(input.workflowInstanceId);
    const installerStatus = await unlessMissing(() =>
      runtime.workflowsFragment.callServices(() =>
        services.getInstanceStatus(CODEMODE_WORKFLOW, installerInstanceId),
      ),
    );
    const installer = installerStatus && {
      workflowInstanceId: installerInstanceId,
      status: installerStatus.status,
    };
    const release = {
      listingId: params.listingId,
      version: params.version,
      installationRoot: params.installationRoot,
    };
    const described = describeExistingMarketplaceWorkflow({
      operation: {
        label: "ingestion",
        failedErrorName: "MarketplaceIngestionFailed",
        terminatedErrorName: "MarketplaceIngestionTerminated",
      },
      status,
      workflowInstanceId: input.workflowInstanceId,
    });
    switch (described.state) {
      case "pending":
        return { ...release, status: described.workflowStatus, installer };
      case "complete":
        return { ...release, status: "complete", installer };
      case "failed":
        return { ...release, status: described.workflowStatus, error: described.error, installer };
    }

    throw new Error("Unsupported marketplace workflow state.");
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

  async listExternalIdentityBindings(
    input: ListExternalIdentityBindingsInput,
    context: BackofficeActionRpcContext,
  ): Promise<ExternalIdentityBindingPage> {
    const parsed = listExternalIdentityBindingsInputSchema.parse(input);
    const page = parsed.cursor
      ? { after: decodeExternalIdentityBindingCursor(parsed.cursor) }
      : { pageSize: parsed.pageSize };

    return await this.#invokeAutomationAction({
      context,
      operation: BACKOFFICE_PERMISSION.identity.read,
      resource: { kind: "external-identity-bindings" },
      execute: async (runtime) => {
        const result = await runtime.automationFragment.callServices(
          () => runtime.automationFragment.services.listExternalIdentityBindings(page),
          { propagationContext: context.propagationContext },
        );
        return { bindings: result.bindings, cursor: result.cursor?.encode() ?? null };
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

  async listEventsOfType(input: {
    source: string;
    eventType: string;
    cursor: string | null;
  }): Promise<{
    events: (AutomationEventRecord & { createdAt: string })[];
    cursor: string | null;
  }> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const page = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listEventsOfType(input),
    );
    return { events: page.events.map(automationEventRecord), cursor: page.cursor };
  }

  async deleteEventsOfType(input: EventDeletionPass) {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.deleteEventsOfType(input),
    );
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

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listEventDefinitions(),
    );
  }

  async getEventDefinition(input: {
    source: string;
    eventType: string;
  }): Promise<AutomationEventDefinition | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getEventDefinition(input),
    );
  }

  async updateEventDefinition(
    input: AutomationEventDefinitionUpdateInput,
  ): Promise<AutomationEventDefinition | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.updateEventDefinition(input, MEMBERS_STEWARD),
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

  async listPackageInstallations(): Promise<PackageInstallation[]> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listPackageInstallations(),
    );
  }

  async getPackageInstallation(input: { listingId: string }): Promise<PackageInstallation | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getPackageInstallation(input),
    );
  }

  async getPackageInstallationRecord(input: {
    listingId: string;
  }): Promise<PackageInstallationRecord | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getPackageInstallationRecord(input),
    );
  }

  async createFileShare(input: {
    shareId: string;
    path: string;
    target: BackofficeRoutableScope;
  }): Promise<FileShare> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.createFileShare(input),
    );
  }

  async getFileShare(input: { shareId: string }): Promise<FileShare | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getFileShare(input),
    );
  }

  async listFileShares(): Promise<FileShare[]> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listFileShares(),
    );
  }

  async deleteFileShare(input: { shareId: string }): Promise<boolean> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.deleteFileShare(input),
    );
  }

  async acceptFileShare(input: {
    shareId: string;
    name: string;
    source: BackofficeRoutableScope;
    path: string;
  }): Promise<AcceptFileShareOutcome> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.acceptFileShare(input),
    );
  }

  async getAcceptedFileShareByName(input: { name: string }): Promise<AcceptedFileShare | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getAcceptedFileShareByName(input),
    );
  }

  async listAcceptedFileShares(): Promise<AcceptedFileShare[]> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listAcceptedFileShares(),
    );
  }

  async deleteAcceptedFileShare(input: { shareId: string }): Promise<boolean> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.deleteAcceptedFileShare(input),
    );
  }

  async applyPackageInstallation(
    input: PackageInstallationInput,
  ): Promise<PackageInstallationOutcome> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await applyPackageInstallation(runtime.automationFragment, input);
  }

  async uninstallPackage(input: {
    listingId: string;
  }): Promise<PackageAutomationsUninstallation | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await uninstallPackage(runtime.automationFragment, input);
  }

  /** Imports this workspace's legacy Marketplace lock into installation records. */
  async importLegacyPackageInstallations(
    input: PackagesImportLegacyInput,
  ): Promise<LegacyPackageImportOutcome> {
    const scope = this.#requireScope();
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await importLegacyPackageInstallations(runtime.automationFragment, {
      upload: this.#runtimeServices.objects.upload.for(scope).http,
      input,
    });
  }

  async provisionAppProject(input: {
    appId: string;
    externalProjectId: string;
    name: string;
    createdByUserId: string;
  }): Promise<{ projectId: string; slug: string; created: boolean }> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    // Scoped to this object's owner, so the same identifier in another organization names another
    // project.
    const projectId = provisionedResourceId({
      appId: input.appId,
      kind: "project",
      externalId: `${backofficeScopePathSegment(this.#requireScope())}/${input.externalProjectId}`,
    });
    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.provisionAppProject({
        projectId,
        name: input.name,
        createdByUserId: input.createdByUserId,
      }),
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

  async wakeDurableHooks() {
    await this.#host.wake();
  }

  async checkPageQueries(queries: SqlQuery[]): Promise<SqlQueryCheck[]> {
    return await this.#checkSqlQueries(AUTOMATION_PAGE_DATABASE_SCHEMA, queries);
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
