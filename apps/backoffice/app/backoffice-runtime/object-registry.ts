import type {
  AccountInvitationRecord,
  AccountProfile,
  OAuthConsentPage,
} from "@fragno-dev/backoffice-api/v0/account";
import type { AutomationActors } from "@fragno-dev/backoffice-api/v0/automation";
import type {
  AutomationEvent,
  AutomationEventDefinition,
  AutomationEventDefinitionUpdateInput,
  AutomationEventRecord,
} from "@fragno-dev/backoffice-api/v0/events";
import type {
  MarketplaceIngestionRequestInput,
  MarketplaceIngestionRestartResult,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import type {
  MarketplacePublishResult,
  PackageInstallation,
  PackagesImportLegacyInput,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import type {
  MarketplaceFeatureEntry,
  MarketplaceFeaturedResult,
  MarketplaceListingDetail,
  MarketplaceListingPageInput,
  MarketplacePublishedListingInput,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import type {
  OrganizationRole,
  OrganizationInvitationRecord,
  OrganizationMemberPage,
  OrganizationAccessRecord,
  OrganizationMembershipRecord,
  OrganizationRecord,
} from "@fragno-dev/backoffice-api/v0/organization";
import type { JsonValue } from "@fragno-dev/backoffice-api/v0/shared/json";
import type { DirectoryPageInput } from "@fragno-dev/backoffice-api/v0/shared/pagination";
import {
  type BackofficeContextScope,
  type BackofficeJurisdiction,
  type BackofficeRootOwner,
  type BackofficeRoutableScope,
  type BackofficeScopeIdNames,
  backofficeScopePathSegment,
  parseBackofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { AcceptedFileShare, FileShare } from "@fragno-dev/backoffice-api/v0/state";
import type { CodemodeHost } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import type { GitHubWebhookRouter } from "workers/github-webhook-router.do";
import type { GitHub } from "workers/github.do";
import type { SqlQuery, SqlQueryCheck } from "workers/lib/backoffice-object-implementation";
import type { IssueIdentityClaimInput, IssueIdentityClaimResult } from "workers/otp-object";
import type { Otp } from "workers/otp.do";
import type { Resend } from "workers/resend.do";
import type { TelegramAdminConfigResponse } from "workers/telegram-object";

import type { FragnoExecutionContext } from "@fragno-dev/core";
import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import type { ClassifierResult } from "@earendil-works/pi-ai";

import type { BackofficeRootOwnerReference } from "@/backoffice-runtime/resolved-scope";
import type { TelegramAutomationFileMetadata } from "@/backoffice-runtime/telegram-file-response";
import type { AccessCodeCommands } from "@/fragno/access-codes/contracts";
import type {
  AppInstallationOwner,
  BackofficeAppInstallationsCommands,
} from "@/fragno/app-installations/contracts";
import type { BackofficeAppsCommands } from "@/fragno/apps/contracts";
import type { AuthAppProvisioningCommands } from "@/fragno/auth/app-provisioning";
import type {
  AdministeredMember,
  BackofficeCliOAuthConfig,
  BackofficeMeData,
  Organization,
  OrganizationHookPayload,
  UserAuthorityFacts,
  UserOrganizationAuthorityFacts,
  UserOrganizationAuthorityInput,
  VerifyUserEmailInput,
  VerifyUserEmailResult,
} from "@/fragno/auth/contracts";
import type {
  OrganizationInvitationPage,
  OrganizationMemberNumberedPage,
  OrganizationPage,
} from "@/fragno/auth/directory-records";
import type {
  BackofficeExecutionTokenExchangeInput,
  BackofficeExecutionTokenResult,
} from "@/fragno/auth/execution-token";
import type {
  BackofficeOAuthClientCreateRequest,
  BackofficeOAuthClientCreateResult,
  BackofficeOAuthClientFacts,
  BackofficeOAuthClientListInput,
  BackofficeOAuthClientPage,
  BackofficeOAuthClientRotateSecretInput,
  BackofficeOAuthClientRotateSecretResult,
  BackofficeOAuthClientUpdateInput,
  BackofficeOAuthClientUpdateResult,
} from "@/fragno/auth/oauth-client";
import type { AppActionTokenInput } from "@/fragno/auth/token-lifecycle";
import type {
  AutomationIngestResult,
  AutomationProjectExecutionTarget,
  MarketplaceIngestionRequestResult,
  StarterAutomationRoutesSeedResult,
} from "@/fragno/automation";
import type { AutomationRouteAuthorityLookup } from "@/fragno/automation/authority";
import type {
  AutomationEventSource,
  AutomationEventSourceInput,
} from "@/fragno/automation/event-sources";
import type { EventDeletionPass } from "@/fragno/automation/events-storage-runtime";
import type {
  BindExternalIdentityInput,
  BindExternalIdentityResult,
  ExternalIdentityBindingPage,
  GetExternalIdentityBindingInput,
  ListExternalIdentityBindingsInput,
  ResolveExternalIdentityResult,
  RevokeExternalIdentityInput,
  RevokeExternalIdentityResult,
} from "@/fragno/automation/external-identities";
import type { AcceptFileShareOutcome } from "@/fragno/automation/file-shares-storage-runtime";
import type { LegacyPackageImportOutcome } from "@/fragno/automation/legacy-package-installations";
import type {
  PackageAutomationsUninstallation,
  PackageInstallationInput,
  PackageInstallationOutcome,
} from "@/fragno/automation/package-installations";
import type { PackageInstallationRecord } from "@/fragno/automation/package-installations-storage-runtime";
import type {
  BillingEventInput,
  BillingRecordEventResult,
  BillingStatement,
  BillingStatementInput,
  BillingTrackerPage,
  BillingTrackerPageInput,
} from "@/fragno/billing";
import type {
  UsageLimitSetting,
  UsageLimitedMeter,
  UsageLimits,
} from "@/fragno/billing/usage-limits";
import type {
  CodemodeExecution,
  CodemodeRunActivation,
  CodemodeRunContext,
  CodemodeRunDetail,
  CodemodeRunPage,
  CodemodeRunPageInput,
} from "@/fragno/codemode/codemode-fragment";
import type { CodemodeRunLease } from "@/fragno/codemode/codemode-object-execute";
import type {
  DurableHookQueueEntry,
  DurableHookQueueOptions,
  DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
import type { GitHubInstallationOwner } from "@/fragno/github";
import type {
  MarketplaceAddDraftVersionInput,
  MarketplaceArchiveListingInput,
  MarketplaceListingStorage,
  MarketplaceListingStorageInput,
  MarketplaceArchiveResult,
  MarketplaceCreateDraftListingInput,
  MarketplaceDraftResult,
  MarketplaceFeaturedListing,
  MarketplaceFeatureListingInput,
  MarketplaceInsertStaticEntriesInput,
  MarketplaceInsertStaticEntriesResult,
  MarketplaceLatestPublishedVersions,
  MarketplaceLatestPublishedVersionsInput,
  MarketplaceListingPage,
  MarketplaceListingUpdateResult,
  MarketplaceOwnedListingDetail,
  MarketplaceOwnedListingInput,
  MarketplaceOwnedListingPage,
  MarketplaceOwnedListingPageInput,
  MarketplaceOperationResult,
  MarketplaceStaticPublicationResult,
  MarketplacePublishVersionInput,
  MarketplacePublishVersionResult,
  MarketplaceUnfeatureInput,
  MarketplaceUnfeatureResult,
  MarketplaceUpdateListingInput,
} from "@/fragno/marketplace/contracts";
import type {
  MarketplacePublishPackageInput,
  MarketplacePublishReleaseInput,
  MarketplacePublishReleaseResult,
  MarketplacePackagePublishRequest,
} from "@/fragno/marketplace/package-publishing";
import type { OnboardingAnswer, UserOnboardingState } from "@/fragno/onboarding/contracts";
import type { PiExtractionRequest } from "@/fragno/pi/agent/openai-extraction";
import type {
  PiAgentAddress,
  PiAgentSettledTurn,
  PiAgentViewerAuthorization,
} from "@/fragno/pi/agent/pi-agent-contract";
import type {
  PiClassificationRequest,
  PiImageGenerationRequest,
} from "@/fragno/pi/agent/pi-models";
import type { PackageAgentsInput } from "@/fragno/pi/manager/package-agents";
import type {
  SandboxInstanceRecord,
  SandboxInstanceRequestInput,
  SandboxProvider,
} from "@/fragno/sandbox-manager/contracts";
import type {
  PresenceActivity,
  PresenceActivityResult,
  PresenceMember,
} from "@/presence/contracts";
import type { SandboxCommandResult, SandboxInstanceStatus } from "@/sandbox/contracts";

import type {
  BackofficeExecutionContext,
  BackofficeRequestExecution,
  BackofficeDeferredExecution,
} from "./context";

export type BackofficeRpcContext = Pick<FragnoExecutionContext, "propagationContext">;

export type BackofficeActionRpcContext = BackofficeRpcContext & {
  execution: BackofficeExecutionContext;
};

export type FetchCommandsOptions = {
  /**
   * Returns the object's response as is, so workerd moves its body without copying each chunk
   * through JavaScript, and cancels it when the client goes away. Otherwise the body is forwarded
   * through a stream that also cancels it when the request aborts, which a body that can idle
   * indefinitely needs. Only for bodies that keep writing or end on their own.
   */
  passThrough?: boolean;
};

export type FetchCommands = {
  fetch(request: Request, options?: FetchCommandsOptions): Promise<Response>;
};

export type BackofficeObjectHttp = FetchCommands & {
  fetchAuthorized(request: Request, context: BackofficeActionRpcContext): Promise<Response>;
};

/** Separates finite Durable Object RPC commands from native HTTP request/response transport. */
export type BackofficeObjectHandle<TCommands> = {
  commands: TCommands;
  http: BackofficeObjectHttp;
};

type AwaitedMethodReturn<TObject, TKey extends keyof TObject> = TObject[TKey] extends (
  ...args: infer _Args
) => Promise<infer TResult>
  ? TResult
  : never;

/** Exposes durable hook inspection and recovery as finite serializable Durable Object commands. */
export type DurableHookCommands = {
  getDurableHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse>;
  getDurableHook(hookId: string): Promise<DurableHookQueueEntry | null>;
  /**
   * Fires the object's alarm now, which runs its due hooks and schedules the next alarm: recovers
   * an object whose alarm was lost.
   */
  wakeDurableHooks(): Promise<void>;
};

export type AutomationsDurableHookFragment = "automation" | "workflows";

type ScopedObjects<TObject> = {
  singleton(): TObject;
  "for"(scope: BackofficeContextScope): TObject;
  forName(name: string): TObject;
};

/** Live provider evidence that inbound deliveries reach this deployment's webhook URL. */
export type WebhookRegistrationCheck = { registered: boolean; message: string };

export type AdminConfigurableCommands<TConfig = unknown> = {
  getAdminConfig(): Promise<TConfig>;
  resetAdminConfig(): Promise<TConfig>;
  setAdminConfig(...args: unknown[]): Promise<TConfig>;
};

export type ScenarioAuthFixture = {
  users?: ReadonlyArray<{
    id: string;
    email: string;
    role: "user" | "admin";
    status: "active" | "banned";
  }>;
  organizations?: ReadonlyArray<{
    id: string;
    name: string;
    slug: string;
    ownerUserId: string;
    ownerRoles: readonly string[];
  }>;
  members?: ReadonlyArray<{
    organizationId: string;
    userId: string;
    roles: readonly string[];
  }>;
  removedMembers?: ReadonlyArray<{ organizationId: string; userId: string }>;
  /** Users who signed up, by email, who start onboarded, as scenarios rarely onboard them. */
  onboardedEmails?: readonly string[];
};

export type GrantBackofficeAdminResult =
  | { status: "granted"; userId: string }
  | { status: "already_admin"; userId: string }
  | { status: "email_not_verified"; userId: string }
  | { status: "user_not_found" }
  | { status: "user_not_active" };

export type AdminOrganizationRecord = {
  organizationId: string;
  name: string;
  slug: string;
  ownerUserId: string;
};

/** Invitations addressed to a user's email, listed only once they verified they own it. */
export type AccountInvitationListing =
  | { status: "email-unverified" }
  | { status: "listed"; invitations: AccountInvitationRecord[] };

/** A user whose email address an administrator marked as verified. */
export type AdminUserEmailVerificationRecord = {
  userId: string;
  email: string;
  status: "verified" | "already_verified";
};

export type AdminOrganizationMemberRecord = {
  organizationId: string;
  userId: string;
  roles: string[];
};

/** The organization whose members act in another, or null when only its own members do. */
export type OrganizationManagerRecord = {
  organizationId: string;
  managingOrganizationId: string | null;
};

export type OrganizationReference = { organizationId: string; name: string; slug: string };

/** An organization another one manages, as the managing organization lists its clients. */
export type ManagedOrganizationRecord = OrganizationReference & {
  createdAt: string;
  memberCount: number;
};

/** Who acts in an organization: its members, the organization managing it, and those it manages. */
export type OrganizationRelations = {
  memberCount: number;
  managingOrganization: OrganizationReference | null;
  managedOrganizations: ManagedOrganizationRecord[];
};

export type AuthCommands = DurableHookCommands &
  AuthAppProvisioningCommands & {
    enqueueEmailVerificationHook(
      input: { userId: string; email: string },
      propagationContext?: Readonly<Record<string, string>> | null,
    ): Promise<string>;
    enqueueOrganizationHook(
      hookName: "onOrganizationCreated" | "onOrganizationUpdated",
      payload: OrganizationHookPayload,
      propagationContext?: Readonly<Record<string, string>> | null,
    ): Promise<string>;
    verifyUserEmail(input: VerifyUserEmailInput): Promise<VerifyUserEmailResult>;
    getBackofficeMe(input: {
      userId: string;
      activeOrganizationId: string | null;
    }): Promise<BackofficeMeData | null>;
    /** Creates an OAuth client owned by the administrator principal, not an organization installation. */
    createAdminOAuthClient(
      input: BackofficeOAuthClientCreateRequest & { administratorUserId: string },
    ): Promise<BackofficeOAuthClientCreateResult>;
    /** Reads the global, credential-free OAuth catalog under live administrator authority. */
    listAdminOAuthClients(
      input: BackofficeOAuthClientListInput & { administratorUserId: string },
    ): Promise<BackofficeOAuthClientPage>;
    /** Changes an administrator-owned client's redirects, scopes, and client credentials. */
    updateAdminOAuthClient(
      input: BackofficeOAuthClientUpdateInput & { administratorUserId: string },
    ): Promise<BackofficeOAuthClientUpdateResult>;
    /** Replaces an administrator-owned confidential client's secret, returning it once. */
    rotateAdminOAuthClientSecret(
      input: BackofficeOAuthClientRotateSecretInput & { administratorUserId: string },
    ): Promise<BackofficeOAuthClientRotateSecretResult>;
    /** Reads Auth-owned OAuth client facts without exposing credentials. */
    getOAuthClientFacts(input: { clientId: string }): Promise<BackofficeOAuthClientFacts | null>;
    /** Signs a short-lived code that lets the app's server claim an approved installation. */
    issueAppInstallationCode(input: {
      appId: string;
      owner: AppInstallationOwner;
      activation: number;
    }): Promise<{ code: string }>;
    /** Signs one request to an app's action endpoint; the token is valid only for that body. */
    issueAppActionToken(input: AppActionTokenInput): Promise<{ token: string }>;
    getBackofficeCliOAuthConfig(input: { requestUrl: string }): Promise<BackofficeCliOAuthConfig>;
    /** Verifies an installed app's client-credentials token and returns its registered app. */
    authenticateInstalledAppClient(input: {
      requestUrl: string;
      oauthAccessToken: string;
    }): Promise<{ appId: string }>;
    /** Exchanges OAuth identity under a server-controlled execution policy, not app registration alone. */
    exchangeBackofficeExecutionToken(
      input: BackofficeExecutionTokenExchangeInput,
    ): Promise<BackofficeExecutionTokenResult>;
    getUserAuthorityFacts(input: {
      userId: string;
      organizationId?: string;
    }): Promise<UserAuthorityFacts>;
    /** Live: whether the administrator owns or administers an organization the member belongs to. */
    findAdministeredMember(input: {
      administratorId: string;
      memberId: string;
    }): Promise<AdministeredMember | null>;
    /** Where a root owner named by ID keeps its objects; null when it does not exist. */
    findRootOwnerScope(
      owner: BackofficeRootOwnerReference,
    ): Promise<BackofficeRootOwner<BackofficeScopeIdNames> | null>;
    /** Resolves live user status and roles for exactly one organization, without session metadata. */
    getUserOrganizationAuthorityFacts(
      input: UserOrganizationAuthorityInput,
    ): Promise<UserOrganizationAuthorityFacts>;
    /** Grants global administrator access; only the first administrator may be unverified. */
    grantBackofficeAdminByEmail(input: { email: string }): Promise<GrantBackofficeAdminResult>;
    createAdminOrganization(input: {
      name: string;
      slug: string;
      ownerEmail: string;
    }): Promise<AdminOrganizationRecord>;
    /**
     * Creates an organization owned by the user, with the first free slug its name suggests. The
     * same ID again returns the organization it created.
     */
    createUserOrganization(input: {
      id: string;
      userId: string;
      name: string;
    }): Promise<{ id: string; slug: string }>;
    /**
     * Creates a client organization that one the user owns or administers manages. The same ID
     * again returns the organization it created.
     */
    createManagedOrganization(input: {
      id: string;
      userId: string;
      managingOrganizationId: string;
      name: string;
    }): Promise<{ id: string; slug: string }>;
    /** Fixes the jurisdiction of a user's personal scope, before onboarding creates it. */
    chooseUserJurisdiction(input: {
      userId: string;
      jurisdiction: BackofficeJurisdiction | null;
    }): Promise<void>;
    /** Ends a user's onboarding, which creates their personal scope; again, it changes nothing. */
    finishUserOnboarding(input: { userId: string }): Promise<void>;
    /** Marks an email address verified without the owner proving it, as an administrator. */
    verifyAdminUserEmail(input: { email: string }): Promise<AdminUserEmailVerificationRecord>;
    addAdminOrganizationMember(input: {
      organizationId: string;
      userEmail: string;
      roles: readonly OrganizationRole[];
    }): Promise<AdminOrganizationMemberRecord>;
    removeAdminOrganizationMember(input: {
      organizationId: string;
      userEmail: string;
    }): Promise<AdminOrganizationMemberRecord>;
    // Directory commands do not authorize: callers pass the principal or organization that kernel
    // authorization already established for the execution.
    getAccountProfile(input: { userId: string }): Promise<AccountProfile>;
    updateAccountProfile(input: { userId: string; name: string }): Promise<AccountProfile>;
    listAccountOrganizations(input: { userId: string }): Promise<OrganizationMembershipRecord[]>;
    listAccountInvitations(input: { userId: string }): Promise<AccountInvitationListing>;
    /** Accepts as the user, so Better Auth enforces the recipient email, expiry, and status. */
    acceptAccountInvitation(input: {
      userId: string;
      invitationId: string;
    }): Promise<OrganizationMembershipRecord>;
    listAccountOAuthConsents(
      input: { userId: string } & DirectoryPageInput,
    ): Promise<OAuthConsentPage>;
    getOrganization(input: { organizationId: string }): Promise<OrganizationRecord | null>;
    getOrganizationMembership(input: {
      organizationId: string;
      userId: string;
    }): Promise<OrganizationMembershipRecord | null>;
    getOrganizationAccess(input: {
      organizationId: string;
      userId: string;
    }): Promise<OrganizationAccessRecord | null>;
    updateOrganization(input: {
      organizationId: string;
      name: string;
    }): Promise<OrganizationRecord>;
    /**
     * Lets the managing organization's members act in the organization, with their role there as
     * admin at most, or with null ends that. Their access is not membership and does not chain.
     */
    setOrganizationManager(input: {
      organizationId: string;
      managingOrganizationId: string | null;
    }): Promise<OrganizationManagerRecord>;
    /** The organization's member count, its manager, and the organizations it manages by name. */
    getOrganizationRelations(input: { organizationId: string }): Promise<OrganizationRelations>;
    listOrganizations(input: DirectoryPageInput): Promise<OrganizationPage>;
    listOrganizationMembers(
      input: { organizationId: string } & DirectoryPageInput,
    ): Promise<OrganizationMemberPage>;
    /** The members page's numbered pages, oldest member first. */
    listOrganizationMembersByPage(input: {
      organizationId: string;
      page: number;
      pageSize: number;
    }): Promise<OrganizationMemberNumberedPage>;
    listOrganizationInvitations(
      input: { organizationId: string } & DirectoryPageInput,
    ): Promise<OrganizationInvitationPage>;
    /** Invites as the inviter, so Better Auth enforces membership, duplicate, and owner-role rules. */
    createOrganizationInvitation(input: {
      organizationId: string;
      inviterUserId: string;
      email: string;
      roles: readonly OrganizationRole[];
    }): Promise<OrganizationInvitationRecord>;
    getAllOrganizations(): Promise<Organization[]>;
    getOrganizationBySlug(
      slug: string,
    ): Promise<Pick<Organization, "id" | "slug" | "jurisdiction"> | null>;
    hasOrganizationMember(input: { organizationId: string; userId: string }): Promise<boolean>;
    getDevOrganizations(): Promise<
      Array<
        Pick<Organization, "id" | "name" | "slug" | "createdBy"> & {
          createdAt: Date;
          updatedAt: Date;
        }
      >
    >;
    /**
     * Applies deterministic auth state for scenario setup without sessions or lifecycle hooks.
     * Production auth flows must use Better Auth's public endpoints instead.
     */
    applyScenarioFixture(fixture: ScenarioAuthFixture): Promise<void>;
    getScenarioMemberRoles(input: {
      organizationId: string;
      userId: string;
    }): Promise<string[] | null>;
  };

/**
 * Starts an object ahead of the pages that use it. Resolves once its constructor's
 * initialization has finished, so a page request after it finds the object ready.
 */
export type WarmableCommands = {
  warm(): Promise<void>;
};

export type ApiCommands = WarmableCommands & DurableHookCommands;

export type WorkersAiModelDescription =
  | {
      status: "available";
      inputSchema: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
    }
  | { status: "unavailable"; reason: string };

export type PiManagerCommands = WarmableCommands & {
  /**
   * An agent reports each settled turn, so its queue can hand the agent its next item, with the
   * event recording how it ended, which the agent its prompt replies to receives.
   */
  reportSettledTurn(input: PiAgentSettledTurn): Promise<void>;
  /**
   * Whether the execution may watch the agent's conversation, which needs `pi.read`, and if so what
   * waits in its queue; an agent asks when a viewer connects to its view socket.
   */
  authorizeViewer(input: {
    agentName: string;
    execution: BackofficeExecutionContext;
  }): Promise<PiAgentViewerAuthorization>;
  /** Classifies and records the usage on the ledger of the scope's root owner. */
  classify(input: {
    request: PiClassificationRequest;
  }): Promise<{ answers: ClassifierResult["answers"] }>;
  /** Generates one image, recorded like `classify`. */
  generateImage(input: { request: PiImageGenerationRequest }): Promise<{ bytes: Uint8Array }>;
  /** Reads files into an answer that matches a JSON Schema, recorded like `classify`. */
  extract(input: { request: PiExtractionRequest }): Promise<{ output: JsonValue }>;
  /** A Workers AI model's input and output JSON Schemas as Cloudflare publishes them. */
  describeWorkersAiModel(input: { model: string }): Promise<WorkersAiModelDescription>;
  /** Runs a Workers AI model and records the neurons it cost, like `classify`. */
  runWorkersAi(input: {
    model: string;
    input: Record<string, JsonValue>;
  }): Promise<{ output: JsonValue }>;
  /** Whether `applyPackageAgents` would accept a package's agents, checked before installing. */
  checkPackageAgents(
    input: Omit<PackageAgentsInput, "actors">,
  ): Promise<PackageInstallationOutcome>;
  /** Makes a package's agents in this scope match its declaration; installing calls it. */
  applyPackageAgents(input: PackageAgentsInput): Promise<PackageInstallationOutcome>;
  /** Deletes a package's agents in this scope and returns their names; uninstalling calls it. */
  removePackageAgents(input: { listingId: string; actors: AutomationActors }): Promise<string[]>;
};

export type BillingCommands = WarmableCommands & {
  recordEvent(
    input: BillingEventInput,
    context?: BackofficeRpcContext,
  ): Promise<BillingRecordEventResult>;
  getStatement(input: BillingStatementInput): Promise<BillingStatement>;
  getTrackers(input: BillingTrackerPageInput): Promise<BillingTrackerPage>;
  /** The owner's limits and usage in the current UTC month. */
  getUsageLimits(): Promise<UsageLimits>;
  setUsageLimit(input: {
    meter: UsageLimitedMeter;
    setting: UsageLimitSetting;
  }): Promise<UsageLimits>;
};

/**
 * Executes activations through the codemode bridge and records each one as a run, with the tool
 * calls its guest makes; a workflow activation is one runner tick. Failures of runs other than
 * ticks become `codemode` events in the same scope's Automations object.
 */
export type CodemodeCommands = WarmableCommands &
  DurableHookCommands & {
    execute<TActivation extends CodemodeRunActivation>(
      activation: TActivation,
      context: CodemodeRunContext,
      host: CodemodeHost,
      lease: CodemodeRunLease,
      // `provider.tool` names whose results the run's history keeps as `[redacted]`.
      redactedResults: readonly string[],
    ): Promise<CodemodeExecution<TActivation>>;
    getRun(runId: string): Promise<CodemodeRunDetail | null>;
    listRuns(input: CodemodeRunPageInput): Promise<CodemodeRunPage>;
  };

export type MarketplaceCommands = {
  publishRelease(
    input: MarketplacePublishReleaseInput,
    context: BackofficeActionRpcContext,
  ): Promise<MarketplacePublishReleaseResult>;
  publishPackage(
    input: MarketplacePublishPackageInput,
    context: BackofficeActionRpcContext,
  ): Promise<MarketplacePublishResult>;
  beginPackagePublish(
    request: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<"publishing" | "published">;
  completePackagePublish(
    request: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<void>;
  failPackagePublish(input: {
    listingId: string;
    version: string;
    workflowInstanceId: string;
  }): Promise<void>;
  listPublishedListings(input?: MarketplaceListingPageInput): Promise<MarketplaceListingPage>;
  getPublishedListing(
    input: MarketplacePublishedListingInput,
  ): Promise<MarketplaceListingDetail | null>;
  getListingStorage(
    input: MarketplaceListingStorageInput,
  ): Promise<MarketplaceListingStorage | null>;
  getLatestPublishedVersions(
    input: MarketplaceLatestPublishedVersionsInput,
  ): Promise<MarketplaceLatestPublishedVersions>;
  listFeaturedListings(): Promise<{ listings: MarketplaceFeaturedListing[] }>;
  listFeatureEntries(): Promise<MarketplaceFeaturedResult>;
  featureListing(
    input: MarketplaceFeatureListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceFeatureEntry>>;
  unfeatureListing(
    input: MarketplaceUnfeatureInput,
  ): Promise<MarketplaceOperationResult<MarketplaceUnfeatureResult>>;
  listOwnedListings(input: MarketplaceOwnedListingPageInput): Promise<MarketplaceOwnedListingPage>;
  getOwnedListing(
    input: MarketplaceOwnedListingInput,
  ): Promise<MarketplaceOwnedListingDetail | null>;
  insertStaticEntries(
    input: MarketplaceInsertStaticEntriesInput,
  ): Promise<MarketplaceOperationResult<MarketplaceInsertStaticEntriesResult>>;
  createDraftListing(
    input: MarketplaceCreateDraftListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceDraftResult>>;
  addDraftVersion(
    input: MarketplaceAddDraftVersionInput,
  ): Promise<MarketplaceOperationResult<MarketplaceDraftResult>>;
  updateListing(
    input: MarketplaceUpdateListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceListingUpdateResult>>;
  publishVersion(
    input: MarketplacePublishVersionInput,
  ): Promise<MarketplaceOperationResult<MarketplacePublishVersionResult>>;
  archiveListing(
    input: MarketplaceArchiveListingInput,
  ): Promise<MarketplaceOperationResult<MarketplaceArchiveResult>>;
};

export type AutomationsCommands = {
  /** Captured bytes become immutable workflow input; returns whether this call created the instance. */
  requestMarketplacePackagePublish(
    request: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<boolean>;
  triggerIngestEvent(
    event: AutomationEvent,
    context?: BackofficeRpcContext,
  ): Promise<AutomationIngestResult>;
  ingestEvent(
    event: AutomationEvent,
    context?: BackofficeRpcContext,
  ): Promise<AutomationIngestResult>;
  /** Trusted authority lookup; it must not require the permission it is being used to resolve. */
  getRouteForAuthority(input: { id: string }): ReturnType<AutomationRouteAuthorityLookup>;
  seedStarterAutomationRoutes(): Promise<StarterAutomationRoutesSeedResult>;
  /** Only System's Automations onboard people; starting again finds the onboarding started. */
  startUserOnboarding(input: { userId: string }): Promise<UserOnboardingState>;
  answerUserOnboarding(input: { userId: string; answer: OnboardingAnswer }): Promise<void>;
  /** Only singleton Automations may run bundled marketplace publication workflows. */
  requestStaticMarketplacePublications(input?: {
    force?: boolean;
  }): Promise<MarketplaceStaticPublicationResult>;
  requestMarketplaceIngestion(
    input: MarketplaceIngestionRequestInput,
    context: BackofficeActionRpcContext,
  ): Promise<MarketplaceIngestionRequestResult>;
  restartMarketplaceIngestion(
    input: MarketplaceIngestionRequestInput,
    context: BackofficeActionRpcContext,
  ): Promise<MarketplaceIngestionRestartResult>;
  bindExternalIdentity(
    input: BindExternalIdentityInput,
    context: BackofficeActionRpcContext,
  ): Promise<BindExternalIdentityResult>;
  revokeExternalIdentity(
    input: RevokeExternalIdentityInput,
    context: BackofficeActionRpcContext,
  ): Promise<RevokeExternalIdentityResult>;
  resolveExternalIdentity(
    input: GetExternalIdentityBindingInput,
    context: BackofficeActionRpcContext,
  ): Promise<ResolveExternalIdentityResult>;
  listExternalIdentityBindings(
    input: ListExternalIdentityBindingsInput,
    context: BackofficeActionRpcContext,
  ): Promise<ExternalIdentityBindingPage>;
  /** One source's events of one type in this scope, newest first; a null cursor is the last page. */
  listEventsOfType(input: {
    source: string;
    eventType: string;
    cursor: string | null;
  }): Promise<{ events: (AutomationEventRecord & { createdAt: string })[]; cursor: string | null }>;
  /** One pass of a destructive cleanup; repeat with the returned cursor until it is null. */
  deleteEventsOfType(
    input: EventDeletionPass,
  ): Promise<{ scanned: number; deleted: number; cursor: string | null }>;
  listEventSources(): Promise<AutomationEventSource[]>;
  getEventSource(input: { source: string }): Promise<AutomationEventSource | null>;
  ensureEventSource(input: AutomationEventSourceInput): Promise<AutomationEventSource>;
  listEventDefinitions(): Promise<AutomationEventDefinition[]>;
  getEventDefinition(input: {
    source: string;
    eventType: string;
  }): Promise<AutomationEventDefinition | null>;
  updateEventDefinition(
    input: AutomationEventDefinitionUpdateInput,
  ): Promise<AutomationEventDefinition | null>;
  resolveProjectForExecution(input: {
    projectId?: string;
    slug?: string;
  }): Promise<AutomationProjectExecutionTarget | null>;
  listPackageInstallations(): Promise<PackageInstallation[]>;
  getPackageInstallation(input: { listingId: string }): Promise<PackageInstallation | null>;
  /** The installation and the install run that last wrote it, which installing checks against. */
  getPackageInstallationRecord(input: {
    listingId: string;
  }): Promise<PackageInstallationRecord | null>;
  /** Folders this scope shares, by share ID; deleting one revokes it. */
  createFileShare(input: {
    shareId: string;
    path: string;
    target: BackofficeRoutableScope;
  }): Promise<FileShare>;
  getFileShare(input: { shareId: string }): Promise<FileShare | null>;
  listFileShares(): Promise<FileShare[]>;
  deleteFileShare(input: { shareId: string }): Promise<boolean>;
  /** Shares other scopes offered and this scope accepted, by share ID. */
  acceptFileShare(input: {
    shareId: string;
    name: string;
    source: BackofficeRoutableScope;
    path: string;
  }): Promise<AcceptFileShareOutcome>;
  /** The share this scope mounts as /shared/<name>/. */
  getAcceptedFileShareByName(input: { name: string }): Promise<AcceptedFileShare | null>;
  listAcceptedFileShares(): Promise<AcceptedFileShare[]>;
  deleteAcceptedFileShare(input: { shareId: string }): Promise<boolean>;
  /** Records a package installation and syncs the routes and event definitions it declares here. */
  applyPackageInstallation(input: PackageInstallationInput): Promise<PackageInstallationOutcome>;
  uninstallPackage(input: { listingId: string }): Promise<PackageAutomationsUninstallation | null>;
  /** Imports the workspace's legacy Marketplace lock into installation records. */
  importLegacyPackageInstallations(
    input: PackagesImportLegacyInput,
  ): Promise<LegacyPackageImportOutcome>;
  /** Idempotent on the app and its identifier for the project. */
  provisionAppProject(input: {
    appId: string;
    externalProjectId: string;
    name: string;
    createdByUserId: string;
  }): Promise<{ projectId: string; slug: string; created: boolean }>;
  getDurableHookQueue(
    fragment: AutomationsDurableHookFragment,
    options?: DurableHookQueueOptions,
  ): Promise<DurableHookQueueResponse>;
  getDurableHook(
    fragment: AutomationsDurableHookFragment,
    hookId: string,
  ): Promise<DurableHookQueueEntry | null>;
  /** Both fragments' hooks share the object's alarm, so one wake runs either's. */
  wakeDurableHooks: DurableHookCommands["wakeDurableHooks"];
  /** Runs each of a page's queries on an empty database of the relations pages read. */
  checkPageQueries(queries: SqlQuery[]): Promise<SqlQueryCheck[]>;
};

export type TelegramCommands = DurableHookCommands &
  AdminConfigurableCommands<TelegramAdminConfigResponse> & {
    getAutomationFile(input: { fileId: string }): Promise<TelegramAutomationFileMetadata>;
    /** Throws when Telegram is not configured. */
    checkWebhook(): Promise<WebhookRegistrationCheck>;
  };

export type OtpCommands = DurableHookCommands &
  AccessCodeCommands & {
    issueEmailVerification(
      input: Parameters<Otp["issueEmailVerification"]>[0],
    ): Promise<AwaitedMethodReturn<Otp, "issueEmailVerification">>;
    confirmEmailVerificationChallenge(
      input: Parameters<Otp["confirmEmailVerificationChallenge"]>[0],
    ): Promise<AwaitedMethodReturn<Otp, "confirmEmailVerificationChallenge">>;
    issueIdentityClaim(
      input: IssueIdentityClaimInput,
      execution: BackofficeDeferredExecution,
    ): Promise<IssueIdentityClaimResult>;
    getIdentityClaim(input: {
      externalId: string;
      code: string;
    }): Promise<AwaitedMethodReturn<Otp, "getIdentityClaim">>;
    confirmIdentityClaim(
      input: { externalId: string; code: string },
      execution: BackofficeRequestExecution,
    ): Promise<AwaitedMethodReturn<Otp, "confirmIdentityClaim">>;
  };

export type ResendCommands = DurableHookCommands &
  AdminConfigurableCommands<AwaitedMethodReturn<Resend, "getAdminConfig">> & {
    queueEmail(
      input: ResendSendEmailInput,
      options: { idempotencyKey: string; senderName: string | null },
    ): Promise<void>;
    /** Throws when Resend is not configured. */
    checkWebhook(): Promise<WebhookRegistrationCheck>;
  };
export type McpCommands = DurableHookCommands;
/** Connector has HTTP operations only; provider tokens stay upstream. */
export type ProjectConnectorCommands = Record<never, never>;
export type UploadCommands = WarmableCommands & DurableHookCommands;
export type BlobsCommands = WarmableCommands & DurableHookCommands;
export type CloudflareCommands = Record<never, never>;
export type FormsCommands = DurableHookCommands;
export type GitHubCommands = DurableHookCommands & {
  ensureAdminConfig(): Promise<AwaitedMethodReturn<GitHub, "ensureAdminConfig">>;
  redeliverFailedInstallationWebhooks(installationId: string): Promise<void>;
};

export type SandboxManagerCommands = WarmableCommands & {
  listSandboxInstances(input?: {
    provider?: SandboxProvider;
    limit?: number;
  }): Promise<SandboxInstanceRecord[]>;
  getSandboxInstance(input: { id: string }): Promise<SandboxInstanceRecord | null>;
  requestSandboxInstance(input: SandboxInstanceRequestInput): Promise<SandboxInstanceRecord>;
  requestSandboxInstanceStop(input: { id: string }): Promise<SandboxInstanceRecord | null>;
  executeSandboxCommand(input: {
    sandboxId: string;
    command: string;
    timeoutMs?: number;
  }): Promise<SandboxCommandResult>;
};

/**
 * Remembers who in an organization was recently active in Backoffice, and where. A user without
 * an active organization has a room of their own, which only decides warming.
 */
export type PresenceCommands = {
  recordActivity(activity: PresenceActivity): Promise<PresenceActivityResult>;
  listActiveMembers(): Promise<PresenceMember[]>;
};

type SandboxCommands = {
  getRuntimeStatus(): Promise<{ status: SandboxInstanceStatus }>;
};

export type GitHubWebhookRouterCommands = {
  getAdminConfig(
    orgId: string,
    origin: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "getAdminConfig">>;
  isAppConfigured(): Promise<boolean>;
  createInstallStatefulUrl(
    userId: string,
    owner: GitHubInstallationOwner,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "createInstallStatefulUrl">>;
  requestRepositoryInstall(
    userId: string,
    owner: GitHubInstallationOwner,
    repositoryFullName: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "requestRepositoryInstall">>;
  getPendingInstall(
    userId: string,
    owner: GitHubInstallationOwner,
    account: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "getPendingInstall">>;
  resolveInstallState(
    input: unknown,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "resolveInstallState">>;
  consumeInstallState(
    input: unknown,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "consumeInstallState">>;
  storeInstallationClaimState(
    input: unknown,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "storeInstallationClaimState">>;
  resolveInstallationClaimState(
    input: unknown,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "resolveInstallationClaimState">>;
  storeInstallationClaimCompletion(
    input: unknown,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "storeInstallationClaimCompletion">>;
  consumeInstallationClaimState(
    input: unknown,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "consumeInstallationClaimState">>;
  setInstallationOwner(
    installationId: string,
    owner: GitHubInstallationOwner,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "setInstallationOwner">>;
  getInstallationOwner(
    installationId: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "getInstallationOwner">>;
  clearInstallationRouting(
    installationId: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "clearInstallationRouting">>;
  getWebhookRouterSnapshot(): Promise<
    AwaitedMethodReturn<GitHubWebhookRouter, "getWebhookRouterSnapshot">
  >;
};

export type BackofficeObjectBindingName =
  | "PRESENCE"
  | "APPS"
  | "APP_INSTALLATIONS"
  | "API"
  | "AUTH"
  | "AUTOMATIONS"
  | "PI_MANAGER"
  | "BILLING"
  | "CODEMODE"
  | "MARKETPLACE"
  | "TELEGRAM"
  | "OTP"
  | "RESEND"
  | "MCP"
  | "PROJECT_CONNECTOR"
  | "UPLOAD"
  | "BLOBS"
  | "GITHUB"
  | "GITHUB_WEBHOOK_ROUTER"
  | "CLOUDFLARE"
  | "FORMS"
  | "SANDBOX"
  | "SANDBOX_MANAGER";

export type BackofficeObjectBinding<_TCommands> = {
  name: BackofficeObjectBindingName;
};

/** A context scope's object, a deployment-wide singleton, or a standalone named object. */
export type BackofficeObjectScope =
  | BackofficeRoutableScope
  | { kind: "singleton" }
  | { kind: "named"; name: string };

export type BackofficeObjectAddress = {
  binding: BackofficeObjectBindingName;
  scope: BackofficeObjectScope;
};

export type BackofficeObjectScopeKind = BackofficeObjectScope["kind"];

export const backofficeObjectScopePolicy = {
  API: ["org", "user", "project"],
  AUTH: ["singleton"],
  APPS: ["singleton"],
  APP_INSTALLATIONS: ["org", "user"],

  // An installed app's workspace keeps its data: store, files, events, routes, and workflows.
  AUTOMATIONS: ["singleton", "org", "user", "app", "project"],
  PI_MANAGER: ["singleton", "org", "user", "project"],
  BILLING: ["org", "user"],
  CODEMODE: ["singleton", "org", "user", "app", "project"],
  MARKETPLACE: ["singleton", "org"],

  TELEGRAM: ["singleton", "org", "user", "project"],
  OTP: ["singleton", "org"],
  RESEND: ["singleton", "org"],
  MCP: ["org", "user", "project"],
  PROJECT_CONNECTOR: ["user"],
  UPLOAD: ["org", "named", "user", "app", "project"],
  BLOBS: ["org", "user", "app", "project"],
  GITHUB: ["org", "user"],

  GITHUB_WEBHOOK_ROUTER: ["singleton"],
  CLOUDFLARE: ["singleton"],
  FORMS: ["singleton"],
  PRESENCE: ["org", "user"],

  SANDBOX: ["named"],
  SANDBOX_MANAGER: ["singleton", "org", "user", "project"],
} satisfies Record<BackofficeObjectBindingName, readonly BackofficeObjectScopeKind[]>;

export const isBackofficeObjectScopeAllowed = (
  binding: BackofficeObjectBindingName,
  scopeKind: BackofficeObjectScopeKind,
) => {
  const allowedScopes: readonly BackofficeObjectScopeKind[] = backofficeObjectScopePolicy[binding];
  return allowedScopes.includes(scopeKind);
};

export const backofficeObjectScopeKindFromContextScope = (
  scope: BackofficeContextScope,
): BackofficeObjectScopeKind => (scope.kind === "system" ? "singleton" : scope.kind);

export const isBackofficeObjectAvailableInContext = (
  binding: BackofficeObjectBindingName,
  scope: BackofficeContextScope,
) => isBackofficeObjectScopeAllowed(binding, backofficeObjectScopeKindFromContextScope(scope));

export const assertBackofficeObjectAddressAllowed = (address: BackofficeObjectAddress) => {
  if (!isBackofficeObjectScopeAllowed(address.binding, address.scope.kind)) {
    throw new Error(
      `Backoffice object ${address.binding} cannot be instantiated with ${address.scope.kind} scope. Allowed scopes: ${backofficeObjectScopePolicy[address.binding].join(", ")}.`,
    );
  }
};

export type BackofficeObjectFactory = {
  get<TCommands>(
    binding: BackofficeObjectBinding<TCommands>,
    address: BackofficeObjectAddress,
  ): BackofficeObjectHandle<TCommands>;
  /** An agent object, which only its view socket reaches over HTTP; see `PiAgent.fetch`. */
  piAgent(agent: PiAgentAddress): Pick<BackofficeObjectHttp, "fetchAuthorized">;
};

const binding = <TObject>(name: BackofficeObjectBindingName): BackofficeObjectBinding<TObject> => ({
  name,
});

const validateScopeValue = (label: string, value: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Backoffice object address requires a non-empty ${label}.`);
  }

  return normalized;
};

const singleton = (): BackofficeObjectScope => ({
  kind: "singleton",
});

const named = (name: string): BackofficeObjectScope => ({
  kind: "named",
  name: validateScopeValue("name", name),
});

// Operator note: this v1 encoder is a full Durable Object identity reset. Existing
// state stored under legacy raw names is intentionally not discovered by this model.
// App and project names embed their owner's segment (`v1:project:org:<orgId>:<projectId>`), so
// project objects named before projects had owners are orphaned and no longer decode.
export const decodeBackofficeObjectScope = (encodedName: string): BackofficeObjectScope | null => {
  const [version, kind, ...encodedValues] = encodedName.split(":");
  if (version !== "v1") {
    return null;
  }

  try {
    if (kind === "singleton") {
      return encodedValues.length === 0 ? singleton() : null;
    }
    if (kind === "named") {
      return encodedValues.length === 1 ? named(decodeURIComponent(encodedValues[0])) : null;
    }
    const scope = parseBackofficeScopePathSegment(encodedName.slice(version.length + 1));
    return scope.kind === "system" ? null : scope;
  } catch {
    return null;
  }
};

export function backofficeContextScopeFromDurableObjectId(
  id: DurableObjectId,
  bindingName: BackofficeObjectBindingName,
): BackofficeContextScope | null {
  // TODO(Wilco): should just throw here
  if (!id.name) {
    return null;
  }

  const scope = decodeBackofficeObjectScope(id.name);
  if (!scope) {
    throw new Error(`Backoffice object ${bindingName} has an invalid named identity.`);
  }
  assertBackofficeObjectAddressAllowed({ binding: bindingName, scope });
  return objectScopeToContextScope(scope);
}

export function requireBackofficeContextScopeFromDurableObjectId(
  id: DurableObjectId,
  bindingName: BackofficeObjectBindingName,
): BackofficeContextScope {
  const scope = backofficeContextScopeFromDurableObjectId(id, bindingName);
  if (!scope) {
    throw new Error(`Backoffice object ${bindingName} requires a named Durable Object identity.`);
  }
  return scope;
}

export const encodeBackofficeObjectAddress = ({ scope }: BackofficeObjectAddress): string => {
  if (scope.kind === "singleton") {
    return "v1:singleton";
  }
  if (scope.kind === "named") {
    return `v1:named:${encodeURIComponent(scope.name)}`;
  }
  // A context scope's object is named by the scope's canonical path segment.
  return `v1:${backofficeScopePathSegment(scope)}`;
};

export function backofficeObjectScopeFromContextScope(
  scope: BackofficeContextScope,
): BackofficeObjectScope {
  return scope.kind === "system" ? singleton() : scope;
}

export function objectScopeToContextScope(scope: BackofficeObjectScope): BackofficeContextScope {
  if (scope.kind === "singleton") {
    return { kind: "system" };
  }
  if (scope.kind === "named") {
    throw new Error("Named Backoffice object scopes do not have a Backoffice context scope.");
  }
  return scope;
}

const objectAddress = (
  objectBinding: BackofficeObjectBinding<unknown>,
  scope: BackofficeObjectScope,
): BackofficeObjectAddress => ({
  binding: objectBinding.name,
  scope,
});

const scopedObject = <TCommands>(
  factory: BackofficeObjectFactory,
  objectBinding: BackofficeObjectBinding<TCommands>,
  address: BackofficeObjectAddress,
): BackofficeObjectHandle<TCommands> => factory.get(objectBinding, address);

const scoped = <TCommands>(
  factory: BackofficeObjectFactory,
  objectBinding: BackofficeObjectBinding<TCommands>,
): ScopedObjects<BackofficeObjectHandle<TCommands>> => ({
  singleton() {
    return scopedObject(factory, objectBinding, objectAddress(objectBinding, singleton()));
  },
  for(scope: BackofficeContextScope) {
    return scopedObject(
      factory,
      objectBinding,
      objectAddress(objectBinding, backofficeObjectScopeFromContextScope(scope)),
    );
  },
  forName(name: string) {
    return scopedObject(factory, objectBinding, objectAddress(objectBinding, named(name)));
  },
});

export const createBackofficeObjectRegistry = (factory: BackofficeObjectFactory) => ({
  api: scoped(factory, binding<ApiCommands>("API")),
  auth: scoped(factory, binding<AuthCommands>("AUTH")),
  apps: scoped(factory, binding<BackofficeAppsCommands>("APPS")),
  appInstallations: scoped(
    factory,
    binding<BackofficeAppInstallationsCommands>("APP_INSTALLATIONS"),
  ),

  automations: scoped(factory, binding<AutomationsCommands>("AUTOMATIONS")),
  piManager: scoped(factory, binding<PiManagerCommands>("PI_MANAGER")),
  piAgent: (agent: PiAgentAddress) => factory.piAgent(agent),
  billing: scoped(factory, binding<BillingCommands>("BILLING")),
  codemode: scoped(factory, binding<CodemodeCommands>("CODEMODE")),
  marketplace: scoped(factory, binding<MarketplaceCommands>("MARKETPLACE")),
  telegram: scoped(factory, binding<TelegramCommands>("TELEGRAM")),
  otp: scoped(factory, binding<OtpCommands>("OTP")),
  resend: scoped(factory, binding<ResendCommands>("RESEND")),
  mcp: scoped(factory, binding<McpCommands>("MCP")),
  projectConnector: scoped(factory, binding<ProjectConnectorCommands>("PROJECT_CONNECTOR")),
  upload: scoped(factory, binding<UploadCommands>("UPLOAD")),
  blobs: scoped(factory, binding<BlobsCommands>("BLOBS")),
  github: scoped(factory, binding<GitHubCommands>("GITHUB")),

  githubWebhookRouter: scoped(
    factory,
    binding<GitHubWebhookRouterCommands>("GITHUB_WEBHOOK_ROUTER"),
  ),
  cloudflare: scoped(factory, binding<CloudflareCommands>("CLOUDFLARE")),
  forms: scoped(factory, binding<FormsCommands>("FORMS")),
  presence: scoped(factory, binding<PresenceCommands>("PRESENCE")),

  sandbox: scoped(factory, binding<SandboxCommands>("SANDBOX")),
  sandboxManager: scoped(factory, binding<SandboxManagerCommands>("SANDBOX_MANAGER")),
});

export type BackofficeObjectRegistry = ReturnType<typeof createBackofficeObjectRegistry>;
