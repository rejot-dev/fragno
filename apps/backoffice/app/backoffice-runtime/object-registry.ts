import type {
  AccountInvitationRecord,
  AccountProfile,
  OAuthConsentPage,
} from "@fragno-dev/backoffice-api/v0/account";
import type { AutomationActor } from "@fragno-dev/backoffice-api/v0/automation";
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
import type { MarketplacePublishResult } from "@fragno-dev/backoffice-api/v0/marketplace";
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
  OrganizationMembershipRecord,
  OrganizationRecord,
} from "@fragno-dev/backoffice-api/v0/organization";
import type { DirectoryPageInput } from "@fragno-dev/backoffice-api/v0/shared/pagination";
import {
  type BackofficeContextScope,
  type BackofficeRoutableScope,
  backofficeScopePathSegment,
  parseBackofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { CodemodeHost } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import type { GitHubWebhookRouter } from "workers/github-webhook-router.do";
import type { GitHub } from "workers/github.do";
import type { IssueIdentityClaimInput, IssueIdentityClaimResult, Otp } from "workers/otp.do";
import type { Resend } from "workers/resend.do";
import type { TelegramAdminConfigResponse } from "workers/telegram.do";
import type { Upload } from "workers/upload.do";

import type { FragnoExecutionContext } from "@fragno-dev/core";
import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import type { TelegramAutomationFileMetadata } from "@/backoffice-runtime/telegram-file-response";
import type {
  AppInstallationOwner,
  BackofficeAppInstallationsCommands,
} from "@/fragno/app-installations/contracts";
import type { BackofficeAppsCommands } from "@/fragno/apps/contracts";
import type { AuthAppProvisioningCommands } from "@/fragno/auth/app-provisioning";
import type {
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
import type { OrganizationInvitationPage, OrganizationPage } from "@/fragno/auth/directory-records";
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
import type {
  BillingEventInput,
  BillingRecordEventResult,
  BillingStatement,
  BillingStatementInput,
  BillingTrackerPage,
  BillingTrackerPageInput,
} from "@/fragno/billing";
import type {
  CodemodeExecution,
  CodemodeRunActivation,
  CodemodeRunContext,
  CodemodeRun,
  CodemodeRunPage,
  CodemodeRunPageInput,
} from "@/fragno/codemode/codemode-fragment";
import type {
  DurableHookQueueEntry,
  DurableHookQueueOptions,
  DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
import type {
  MarketplaceAddDraftVersionInput,
  MarketplaceArchiveListingInput,
  MarketplaceArtifactManifest,
  MarketplaceArtifactManifestInput,
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

export type FetchObject = {
  fetch(request: Request): Promise<Response>;
};

export type BackofficeObjectHttp = FetchObject & {
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

/** Exposes durable hook inspection as finite serializable Durable Object commands. */
export type DurableHookCommands = {
  getDurableHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse>;
  getDurableHook(hookId: string): Promise<DurableHookQueueEntry | null>;
};

export type AutomationsDurableHookFragment = "automation" | "workflows";

type ScopedObjects<TObject> = {
  singleton(): TObject;
  "for"(scope: BackofficeContextScope): TObject;
  forOrg(orgId: string): TObject;
  forName(name: string): TObject;
  forUser(input: { userId: string }): TObject;
};

/** Live provider evidence that inbound deliveries reach this deployment's webhook URL. */
export type WebhookRegistrationCheck = { registered: boolean; message: string };

export type AdminConfigurableObject<TConfig = unknown> = {
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

export type AuthObject = DurableHookCommands &
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
    /** Creates an organization owned by the user, with the first free slug its name suggests. */
    createUserOrganization(input: {
      userId: string;
      name: string;
    }): Promise<{ id: string; slug: string }>;
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
    updateOrganization(input: {
      organizationId: string;
      name: string;
    }): Promise<OrganizationRecord>;
    listOrganizations(input: DirectoryPageInput): Promise<OrganizationPage>;
    listOrganizationMembers(
      input: { organizationId: string } & DirectoryPageInput,
    ): Promise<OrganizationMemberPage>;
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
    getOrganizationBySlug(slug: string): Promise<Pick<Organization, "id" | "slug"> | null>;
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
export type WarmableObject = {
  warm(): Promise<void>;
};

export type ApiObject = WarmableObject & DurableHookCommands;

export type PiManagerObject = WarmableObject & {
  /** An agent reports each settled turn, so its queue can hand the agent its next item. */
  reportSettledTurn(input: { agentName: string; requestId: string }): Promise<void>;
};

export type BillingObject = {
  recordEvent(
    input: BillingEventInput,
    context?: BackofficeRpcContext,
  ): Promise<BillingRecordEventResult>;
  getStatement(input: BillingStatementInput): Promise<BillingStatement>;
  getTrackers(input: BillingTrackerPageInput): Promise<BillingTrackerPage>;
};

/**
 * Executes non-workflow activations through the codemode bridge and records each one as a run.
 * Run starts and outcomes become `codemode` events in the same scope's Automations object.
 */
export type CodemodeObject = WarmableObject &
  DurableHookCommands & {
    execute(
      activation: CodemodeRunActivation,
      context: CodemodeRunContext,
      host: CodemodeHost,
    ): Promise<CodemodeExecution>;
    getRun(runId: string): Promise<CodemodeRun | null>;
    listRuns(input: CodemodeRunPageInput): Promise<CodemodeRunPage>;
  };

export type MarketplaceObject = {
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
  getArtifactManifest(
    input: MarketplaceArtifactManifestInput,
  ): Promise<MarketplaceArtifactManifest | null>;
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

export type AutomationsObject = {
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
};

export type TelegramObject = DurableHookCommands &
  AdminConfigurableObject<TelegramAdminConfigResponse> & {
    getAutomationFile(input: { fileId: string }): Promise<TelegramAutomationFileMetadata>;
    /** Throws when Telegram is not configured. */
    checkWebhook(): Promise<WebhookRegistrationCheck>;
  };

export type OtpObject = DurableHookCommands & {
  issueEmailVerification(
    input: Parameters<Otp["issueEmailVerification"]>[0],
  ): Promise<AwaitedMethodReturn<Otp, "issueEmailVerification">>;
  confirmEmailVerificationChallenge(
    input: Parameters<Otp["confirmEmailVerificationChallenge"]>[0],
  ): Promise<AwaitedMethodReturn<Otp, "confirmEmailVerificationChallenge">>;
  issueSignUpInvitation(
    input: Parameters<Otp["issueSignUpInvitation"]>[0],
  ): Promise<AwaitedMethodReturn<Otp, "issueSignUpInvitation">>;
  confirmSignUpInvitation(
    input: Parameters<Otp["confirmSignUpInvitation"]>[0],
  ): Promise<AwaitedMethodReturn<Otp, "confirmSignUpInvitation">>;
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

export type ResendObject = DurableHookCommands &
  AdminConfigurableObject<AwaitedMethodReturn<Resend, "getAdminConfig">> & {
    queueEmail(
      input: ResendSendEmailInput,
      options: { idempotencyKey: string; senderName: string | null },
    ): Promise<void>;
    /** Throws when Resend is not configured. */
    checkWebhook(): Promise<WebhookRegistrationCheck>;
  };
export type McpObject = DurableHookCommands;
/** Connector has HTTP operations only; provider tokens stay upstream. */
export type ProjectConnectorObject = Record<never, never>;
export type UploadObject = WarmableObject &
  DurableHookCommands &
  AdminConfigurableObject<AwaitedMethodReturn<Upload, "getAdminConfig">>;
export type CloudflareObject = Record<never, never>;
export type FormsObject = DurableHookCommands;
export type GitHubObject = DurableHookCommands & {
  ensureAdminConfig(orgId: string): Promise<AwaitedMethodReturn<GitHub, "ensureAdminConfig">>;
  redeliverFailedInstallationWebhooks(installationId: string): Promise<void>;
};

export type SandboxManagerObject = WarmableObject & {
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
export type PresenceObject = {
  recordActivity(activity: PresenceActivity): Promise<PresenceActivityResult>;
  listActiveMembers(): Promise<PresenceMember[]>;
};

type SandboxObject = {
  getRuntimeStatus(): Promise<{ status: SandboxInstanceStatus }>;
};

export type GitHubWebhookRouterObject = {
  getAdminConfig(
    orgId: string,
    origin: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "getAdminConfig">>;
  isAppConfigured(): Promise<boolean>;
  createInstallStatefulUrl(
    userId: string,
    orgId: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "createInstallStatefulUrl">>;
  requestRepositoryInstall(
    userId: string,
    orgId: string,
    repositoryFullName: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "requestRepositoryInstall">>;
  getPendingInstall(
    userId: string,
    orgId: string,
    owner: string,
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
  setInstallationOrg(
    installationId: string,
    orgId: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "setInstallationOrg">>;
  getInstallationOrg(installationId: string): Promise<string | null>;
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
  GITHUB: ["org"],

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

const org = (orgId: string): BackofficeObjectScope => ({
  kind: "org",
  orgId: validateScopeValue("org id", orgId),
});

const named = (name: string): BackofficeObjectScope => ({
  kind: "named",
  name: validateScopeValue("name", name),
});

const user = (input: { userId: string }): BackofficeObjectScope => ({
  kind: "user",
  userId: validateScopeValue("user id", input.userId),
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

export const objectAddressToActor = (
  address: BackofficeObjectAddress,
): AutomationActor<"delegate"> => ({
  scope: "internal",
  type: "object",
  id: `${address.binding}/${encodeBackofficeObjectAddress(address)}`,
  role: "delegate",
});

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
  forOrg(orgId: string) {
    return scopedObject(factory, objectBinding, objectAddress(objectBinding, org(orgId)));
  },
  forName(name: string) {
    return scopedObject(factory, objectBinding, objectAddress(objectBinding, named(name)));
  },
  forUser(input: { userId: string }) {
    return scopedObject(factory, objectBinding, objectAddress(objectBinding, user(input)));
  },
});

export const createBackofficeObjectRegistry = (factory: BackofficeObjectFactory) => ({
  api: scoped(factory, binding<ApiObject>("API")),
  auth: scoped(factory, binding<AuthObject>("AUTH")),
  apps: scoped(factory, binding<BackofficeAppsCommands>("APPS")),
  appInstallations: scoped(
    factory,
    binding<BackofficeAppInstallationsCommands>("APP_INSTALLATIONS"),
  ),

  automations: scoped(factory, binding<AutomationsObject>("AUTOMATIONS")),
  piManager: scoped(factory, binding<PiManagerObject>("PI_MANAGER")),
  billing: scoped(factory, binding<BillingObject>("BILLING")),
  codemode: scoped(factory, binding<CodemodeObject>("CODEMODE")),
  marketplace: scoped(factory, binding<MarketplaceObject>("MARKETPLACE")),
  telegram: scoped(factory, binding<TelegramObject>("TELEGRAM")),
  otp: scoped(factory, binding<OtpObject>("OTP")),
  resend: scoped(factory, binding<ResendObject>("RESEND")),
  mcp: scoped(factory, binding<McpObject>("MCP")),
  projectConnector: scoped(factory, binding<ProjectConnectorObject>("PROJECT_CONNECTOR")),
  upload: scoped(factory, binding<UploadObject>("UPLOAD")),
  github: scoped(factory, binding<GitHubObject>("GITHUB")),

  githubWebhookRouter: scoped(factory, binding<GitHubWebhookRouterObject>("GITHUB_WEBHOOK_ROUTER")),
  cloudflare: scoped(factory, binding<CloudflareObject>("CLOUDFLARE")),
  forms: scoped(factory, binding<FormsObject>("FORMS")),
  presence: scoped(factory, binding<PresenceObject>("PRESENCE")),

  sandbox: scoped(factory, binding<SandboxObject>("SANDBOX")),
  sandboxManager: scoped(factory, binding<SandboxManagerObject>("SANDBOX_MANAGER")),
});

export type BackofficeObjectRegistry = ReturnType<typeof createBackofficeObjectRegistry>;
