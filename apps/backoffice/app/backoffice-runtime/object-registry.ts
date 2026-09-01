import type { GitHubWebhookRouter } from "workers/github-webhook-router.do";
import type { GitHub } from "workers/github.do";
import type { IssueIdentityClaimInput, IssueIdentityClaimResult, Otp } from "workers/otp.do";
import type { Resend } from "workers/resend.do";
import type { Reson8 } from "workers/reson8.do";
import type { TelegramAdminConfigResponse } from "workers/telegram.do";
import type { Upload } from "workers/upload.do";

import type { FragnoExecutionContext } from "@fragno-dev/core";
import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import type {
  BackofficeCliOAuthConfig,
  BackofficeCliTokenResult,
  BackofficeMeData,
  Organization,
  OrganizationHookPayload,
  UserAuthorityFacts,
  VerifyUserEmailInput,
  VerifyUserEmailResult,
} from "@/fragno/auth/contracts";
import type {
  AutomationEvent,
  AutomationEventDefinition,
  AutomationEventDefinitionCreateInput,
  AutomationEventDefinitionUpdateInput,
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
import type { AutomationActor } from "@/fragno/automation/actors";
import type {
  AutomationEventSource,
  AutomationEventSourceInput,
} from "@/fragno/automation/event-sources";
import type {
  BindExternalIdentityInput,
  BindExternalIdentityResult,
  GetExternalIdentityBindingInput,
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
  MarketplaceInsertStaticEntriesInput,
  MarketplaceInsertStaticEntriesResult,
  MarketplaceLatestPublishedVersions,
  MarketplaceLatestPublishedVersionsInput,
  MarketplaceListingDetail,
  MarketplaceListingPage,
  MarketplaceListingPageInput,
  MarketplaceListingUpdateResult,
  MarketplaceOwnedListingDetail,
  MarketplaceOwnedListingInput,
  MarketplaceOwnedListingPage,
  MarketplaceOwnedListingPageInput,
  MarketplaceOperationResult,
  MarketplacePublishedListingInput,
  MarketplaceStaticPublicationResult,
  MarketplacePublishVersionInput,
  MarketplacePublishVersionResult,
  MarketplaceUpdateListingInput,
} from "@/fragno/marketplace/contracts";
import type { PiRuntimeState } from "@/fragno/pi/pi-shared";
import type { TelegramAutomationFileMetadata } from "@/fragno/runtime-tools/families/telegram-runtime";
import type { SandboxInstanceStatus } from "@/sandbox/contracts";

import type { BackofficeContextScope, BackofficeExecutionContext } from "./context";

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

export type AutomationsDurableHookFragment = "automation" | "pi" | "workflows";

type ScopedObjects<TObject> = {
  singleton(): TObject;
  "for"(scope: BackofficeContextScope): TObject;
  forOrg(orgId: string): TObject;
  forName(name: string): TObject;
  forUser(input: { userId: string }): TObject;
  forProject(input: { orgId: string; projectId: string }): TObject;
};

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

export type AdminOrganizationMemberRecord = {
  organizationId: string;
  userId: string;
  roles: string[];
};

export type AuthObject = DurableHookCommands & {
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
  getBackofficeCliOAuthConfig(input: { requestUrl: string }): Promise<BackofficeCliOAuthConfig>;
  exchangeBackofficeOAuthAccessToken(input: {
    requestUrl: string;
    oauthAccessToken: string;
    scope: BackofficeContextScope | null;
  }): Promise<BackofficeCliTokenResult>;
  getUserAuthorityFacts(input: {
    userId: string;
    organizationId?: string;
  }): Promise<UserAuthorityFacts>;
  /** Grants global administrator access; only the first administrator may be unverified. */
  grantBackofficeAdminByEmail(input: { email: string }): Promise<GrantBackofficeAdminResult>;
  createAdminOrganization(input: {
    name: string;
    slug: string;
    ownerEmail: string;
  }): Promise<AdminOrganizationRecord>;
  addAdminOrganizationMember(input: {
    organizationId: string;
    userEmail: string;
    roles: readonly string[];
  }): Promise<AdminOrganizationMemberRecord>;
  removeAdminOrganizationMember(input: {
    organizationId: string;
    userEmail: string;
  }): Promise<AdminOrganizationMemberRecord>;
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

export type ApiObject = DurableHookCommands;

export type BillingObject = {
  recordEvent(
    input: BillingEventInput,
    context?: BackofficeRpcContext,
  ): Promise<BillingRecordEventResult>;
  getStatement(input: BillingStatementInput): Promise<BillingStatement>;
  getTrackers(input: BillingTrackerPageInput): Promise<BillingTrackerPage>;
};

export type MarketplaceObject = {
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
  triggerIngestEvent(
    event: AutomationEvent,
    context?: BackofficeRpcContext,
  ): Promise<AutomationIngestResult>;
  ingestEvent(
    event: AutomationEvent,
    context?: BackofficeRpcContext,
  ): Promise<AutomationIngestResult>;
  seedStarterAutomationRoutes(): Promise<StarterAutomationRoutesSeedResult>;
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
  getMarketplaceIngestion(
    input: MarketplaceIngestionLookupInput,
  ): Promise<MarketplaceIngestionRecord | null>;
  listMarketplaceIngestions(
    input?: MarketplaceIngestionListInput,
  ): Promise<MarketplaceIngestionRecord[]>;
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
  listEventSources(): Promise<AutomationEventSource[]>;
  getEventSource(input: { source: string }): Promise<AutomationEventSource | null>;
  ensureEventSource(input: AutomationEventSourceInput): Promise<AutomationEventSource>;
  listEventDefinitions(): Promise<AutomationEventDefinition[]>;
  getEventDefinition(input: {
    source: string;
    eventType: string;
  }): Promise<AutomationEventDefinition | null>;
  createEventDefinition(
    input: AutomationEventDefinitionCreateInput,
  ): Promise<AutomationEventDefinition>;
  updateEventDefinition(
    input: AutomationEventDefinitionUpdateInput,
  ): Promise<AutomationEventDefinition | null>;
  resolveProjectForExecution(input: {
    projectId?: string;
    slug?: string;
  }): Promise<AutomationProjectExecutionTarget | null>;
  listSandboxInstances(input?: {
    provider?: SandboxProvider;
    limit?: number;
  }): Promise<SandboxInstanceRecord[]>;
  getSandboxInstance(input: { id: string }): Promise<SandboxInstanceRecord | null>;
  requestSandboxInstance(input: SandboxInstanceRequestInput): Promise<SandboxInstanceRecord>;
  requestSandboxInstanceStop(input: { id: string }): Promise<SandboxInstanceRecord | null>;
  getPiRuntimeState(): Promise<PiRuntimeState>;
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
  issueIdentityClaim(input: IssueIdentityClaimInput): Promise<IssueIdentityClaimResult>;
  confirmIdentityClaim(input: unknown): Promise<AwaitedMethodReturn<Otp, "confirmIdentityClaim">>;
};

export type ResendObject = DurableHookCommands &
  AdminConfigurableObject<AwaitedMethodReturn<Resend, "getAdminConfig">> & {
    queueEmail(input: ResendSendEmailInput, options: { idempotencyKey: string }): Promise<void>;
  };
export type Reson8Object = AdminConfigurableObject<
  AwaitedMethodReturn<Reson8, "getAdminConfig">
> & {
  getRealtimeOriginDiagnostic(
    origin: string,
  ): Promise<AwaitedMethodReturn<Reson8, "getRealtimeOriginDiagnostic">>;
};
export type McpObject = DurableHookCommands;
export type UploadObject = DurableHookCommands &
  AdminConfigurableObject<AwaitedMethodReturn<Upload, "getAdminConfig">>;
export type CloudflareObject = Record<never, never>;
export type FormsObject = DurableHookCommands;
export type GitHubObject = DurableHookCommands & {
  ensureAdminConfig(orgId: string): Promise<AwaitedMethodReturn<GitHub, "ensureAdminConfig">>;
  redeliverFailedInstallationWebhooks(installationId: string): Promise<void>;
};

type SandboxObject = {
  getRuntimeStatus(): Promise<{ status: SandboxInstanceStatus }>;
};

export type GitHubWebhookRouterObject = {
  getAdminConfig(
    orgId: string,
    origin: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "getAdminConfig">>;
  createInstallStatefulUrl(
    userId: string,
    orgId: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "createInstallStatefulUrl">>;
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
  | "API"
  | "AUTH"
  | "AUTOMATIONS"
  | "BILLING"
  | "MARKETPLACE"
  | "TELEGRAM"
  | "OTP"
  | "RESEND"
  | "RESON8"
  | "MCP"
  | "UPLOAD"
  | "GITHUB"
  | "GITHUB_WEBHOOK_ROUTER"
  | "CLOUDFLARE"
  | "FORMS"
  | "SANDBOX";

export type BackofficeObjectBinding<_TCommands> = {
  name: BackofficeObjectBindingName;
};

export type BackofficeObjectScope =
  | { kind: "singleton" }
  | { kind: "org"; orgId: string }
  | { kind: "named"; name: string }
  | { kind: "user"; userId: string }
  | { kind: "project"; orgId: string; projectId: string };

export type BackofficeObjectAddress = {
  binding: BackofficeObjectBindingName;
  scope: BackofficeObjectScope;
};

export type BackofficeObjectScopeKind = BackofficeObjectScope["kind"];

export const backofficeObjectScopePolicy = {
  API: ["org", "user", "project"],
  AUTH: ["singleton"],

  AUTOMATIONS: ["singleton", "org", "user", "project"],
  BILLING: ["org"],
  MARKETPLACE: ["singleton"],

  TELEGRAM: ["singleton", "org", "user", "project"],
  OTP: ["singleton", "org"],
  RESEND: ["singleton", "org"],
  RESON8: ["org"],
  MCP: ["org", "user", "project"],
  UPLOAD: ["org", "named", "user", "project"],
  GITHUB: ["org"],

  GITHUB_WEBHOOK_ROUTER: ["singleton"],
  CLOUDFLARE: ["singleton"],
  FORMS: ["singleton"],

  SANDBOX: ["named"],
} satisfies Record<BackofficeObjectBindingName, readonly BackofficeObjectScopeKind[]>;

export const isBackofficeObjectScopeAllowed = (
  binding: BackofficeObjectBindingName,
  scopeKind: BackofficeObjectScopeKind,
) => {
  const allowedScopes: readonly BackofficeObjectScopeKind[] = backofficeObjectScopePolicy[binding];
  return allowedScopes.includes(scopeKind);
};

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

const encodeScopeValue = (label: string, value: string): string =>
  encodeURIComponent(validateScopeValue(label, value));

export const singleton = (): BackofficeObjectScope => ({
  kind: "singleton",
});

export const org = (orgId: string): BackofficeObjectScope => ({
  kind: "org",
  orgId: validateScopeValue("org id", orgId),
});

export const named = (name: string): BackofficeObjectScope => ({
  kind: "named",
  name: validateScopeValue("name", name),
});

export const user = (input: { userId: string }): BackofficeObjectScope => ({
  kind: "user",
  userId: validateScopeValue("user id", input.userId),
});

export const project = (input: { orgId: string; projectId: string }): BackofficeObjectScope => ({
  kind: "project",
  orgId: validateScopeValue("org id", input.orgId),
  projectId: validateScopeValue("project id", input.projectId),
});

// Operator note: this v1 encoder is a full Durable Object identity reset. Existing
// state stored under legacy raw names is intentionally not discovered by this model.
export const decodeBackofficeObjectScope = (encodedName: string): BackofficeObjectScope | null => {
  const [version, kind, ...encodedValues] = encodedName.split(":");
  if (version !== "v1") {
    return null;
  }

  try {
    switch (kind) {
      case "singleton":
        return encodedValues.length === 0 ? singleton() : null;
      case "org":
        return encodedValues.length === 1 ? org(decodeURIComponent(encodedValues[0])) : null;
      case "named":
        return encodedValues.length === 1 ? named(decodeURIComponent(encodedValues[0])) : null;
      case "user":
        return encodedValues.length === 1
          ? user({ userId: decodeURIComponent(encodedValues[0]) })
          : null;
      case "project":
        return encodedValues.length === 2
          ? project({
              orgId: decodeURIComponent(encodedValues[0]),
              projectId: decodeURIComponent(encodedValues[1]),
            })
          : null;
      default:
        return null;
    }
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

export const encodeBackofficeObjectAddress = (address: BackofficeObjectAddress): string => {
  switch (address.scope.kind) {
    case "singleton":
      return "v1:singleton";
    case "org":
      return `v1:org:${encodeScopeValue("org id", address.scope.orgId)}`;
    case "named":
      return `v1:named:${encodeScopeValue("name", address.scope.name)}`;
    case "user":
      return ["v1", "user", encodeScopeValue("user id", address.scope.userId)].join(":");
    case "project":
      return [
        "v1",
        "project",
        encodeScopeValue("org id", address.scope.orgId),
        encodeScopeValue("project id", address.scope.projectId),
      ].join(":");
  }

  throw new Error("Unsupported Backoffice object scope kind.");
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
  switch (scope.kind) {
    case "system":
      return singleton();
    case "org":
      return org(scope.orgId);
    case "user":
      return user({ userId: scope.userId });
    case "project":
      return project({ orgId: scope.orgId, projectId: scope.projectId });
  }

  throw new Error("Unsupported Backoffice context scope kind.");
}

export function objectScopeToContextScope(scope: BackofficeObjectScope): BackofficeContextScope {
  switch (scope.kind) {
    case "singleton":
      return { kind: "system" };
    case "org":
      return { kind: "org", orgId: scope.orgId };
    case "user":
      return { kind: "user", userId: scope.userId };
    case "project":
      return {
        kind: "project",
        orgId: scope.orgId,
        projectId: scope.projectId,
      };
    case "named":
      throw new Error("Named Backoffice object scopes do not have a Backoffice context scope.");
  }

  throw new Error("Unsupported Backoffice object scope kind.");
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
  forProject(input: { orgId: string; projectId: string }) {
    return scopedObject(factory, objectBinding, objectAddress(objectBinding, project(input)));
  },
});

export const createBackofficeObjectRegistry = (factory: BackofficeObjectFactory) => ({
  api: scoped(factory, binding<ApiObject>("API")),
  auth: scoped(factory, binding<AuthObject>("AUTH")),

  automations: scoped(factory, binding<AutomationsObject>("AUTOMATIONS")),
  billing: scoped(factory, binding<BillingObject>("BILLING")),
  marketplace: scoped(factory, binding<MarketplaceObject>("MARKETPLACE")),
  telegram: scoped(factory, binding<TelegramObject>("TELEGRAM")),
  otp: scoped(factory, binding<OtpObject>("OTP")),
  resend: scoped(factory, binding<ResendObject>("RESEND")),
  reson8: scoped(factory, binding<Reson8Object>("RESON8")),
  mcp: scoped(factory, binding<McpObject>("MCP")),
  upload: scoped(factory, binding<UploadObject>("UPLOAD")),
  github: scoped(factory, binding<GitHubObject>("GITHUB")),

  githubWebhookRouter: scoped(factory, binding<GitHubWebhookRouterObject>("GITHUB_WEBHOOK_ROUTER")),
  cloudflare: scoped(factory, binding<CloudflareObject>("CLOUDFLARE")),
  forms: scoped(factory, binding<FormsObject>("FORMS")),

  sandbox: scoped(factory, binding<SandboxObject>("SANDBOX")),
});

export type BackofficeObjectRegistry = ReturnType<typeof createBackofficeObjectRegistry>;
