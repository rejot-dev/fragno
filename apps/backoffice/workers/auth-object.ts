import type { AccountProfile, OAuthConsentPage } from "@fragno-dev/backoffice-api/v0/account";
import {
  type OrganizationAccessRecord,
  type OrganizationRole,
  organizationRoleSchema,
  type OrganizationInvitationRecord,
  type OrganizationMemberPage,
  type OrganizationMembershipRecord,
  type OrganizationRecord,
} from "@fragno-dev/backoffice-api/v0/organization";
import {
  acceptInvitationInputSchema,
  createInvitationInputSchema,
  provisionManagedOrganizationInputSchema,
  provisionOrganizationForInviteeInputSchema,
  provisionOrganizationInputSchema,
  type AcceptInvitationInput,
  type CreateInvitationInput,
  type ListManagedOrganizationsInput,
  type ManagedOrganizationPage,
  type ProvisionManagedOrganizationInput,
  type ProvisionManagedOrganizationResult,
  type ProvisionOrganizationForInviteeInput,
  type ProvisionOrganizationForInviteeResult,
  type ProvisionOrganizationInput,
  type ProvisionOrganizationResult,
} from "@fragno-dev/backoffice-api/v0/provisioning";
import type { DirectoryPageInput } from "@fragno-dev/backoffice-api/v0/shared/pagination";
import {
  type BackofficeContextScope,
  backofficeContextScopesEqual,
  type BackofficeJurisdiction,
  type BackofficeRootOwner,
  backofficeRootOwnerSchema,
  type BackofficeScopeIdNames,
  backofficeScopeOrganization,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { Kysely } from "kysely";
import { z } from "zod";

import { extractW3CRequestPropagationContext } from "@fragno-dev/core";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import type {
  AdminOrganizationMemberRecord,
  AdminOrganizationRecord,
  AccountInvitationListing,
  AdminUserEmailVerificationRecord,
  AuthCommands,
  GrantBackofficeAdminResult,
  OrganizationManagerRecord,
  OrganizationRelations,
  ScenarioAuthFixture,
} from "@/backoffice-runtime/object-registry";
import {
  backofficeOrganizationContextScope,
  backofficePersonalScope,
  type BackofficeRootOwnerReference,
} from "@/backoffice-runtime/resolved-scope";
import { type BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { AppInstallationOwner } from "@/fragno/app-installations/contracts";
import { provisionedResourceId } from "@/fragno/apps/provisioned-id";
import type {
  AppInvitation,
  AppProvisioningResult,
  ProvisioningApp,
} from "@/fragno/auth/app-provisioning";
import {
  type AdministeredMember,
  administersMembers,
  type AuthHookContext,
  type AuthUser,
  type BackofficeCliOAuthConfig,
  type BackofficeMeData,
  joinOrganizationRoles,
  type Organization,
  type OrganizationAccess,
  type OrganizationHookPayload,
  type OrganizationHooks,
  type OrganizationInvitation,
  type Role,
  resolveLiveAccessTokenSecret,
  splitOrganizationRoles,
  type UserAuthorityFacts,
  userOrganizationAuthorityInputSchema,
  type UserOrganizationAuthorityFacts,
  type UserOrganizationAuthorityInput,
  type UserSummary,
  type VerifyUserEmailInput,
  type VerifyUserEmailResult,
  CLIENT_IP_HEADER,
} from "@/fragno/auth/contracts";
import type {
  OrganizationInvitationPage,
  OrganizationMemberNumberedPage,
  OrganizationPage,
} from "@/fragno/auth/directory-records";
import {
  backofficeExecutionTokenExchangeInputSchema,
  type BackofficeExecutionTokenExchangeInput,
  type BackofficeExecutionTokenResult,
} from "@/fragno/auth/execution-token";
import {
  backofficeOAuthClientCreateInputSchema,
  backofficeOAuthClientListInputSchema,
  backofficeOAuthClientRotateSecretInputSchema,
  backofficeOAuthClientUpdateInputSchema,
  type BackofficeOAuthClientCreateRequest,
  type BackofficeOAuthClientCreateResult,
  type BackofficeOAuthClientFacts,
  type BackofficeOAuthClientListInput,
  type BackofficeOAuthClientPage,
  type BackofficeOAuthClientRotateSecretInput,
  type BackofficeOAuthClientRotateSecretResult,
  type BackofficeOAuthClientUpdateInput,
  type BackofficeOAuthClientUpdateResult,
} from "@/fragno/auth/oauth-client";
import { organizationSlugFromName } from "@/fragno/auth/organization-slug";
import {
  BACKOFFICE_PASSWORD_MIN_LENGTH,
  BACKOFFICE_PASSWORD_MAX_LENGTH,
  PASSWORD_RESET_TOKEN_LIFETIME_SECONDS,
} from "@/fragno/auth/password-policy";
import {
  issueAppActionToken,
  issueAppInstallationCode,
  type AppActionTokenInput,
} from "@/fragno/auth/token-lifecycle";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import {
  AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED,
  AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED,
  AUTH_AUTOMATION_SOURCE,
} from "@/fragno/backoffice-capabilities/capabilities/auth";
import type {
  DurableHookQueueEntry,
  DurableHookQueueOptions,
  DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
import { nextNumberedSlug } from "@/lib/numbered-slug";
import { BACKOFFICE_LOGIN_PATH } from "@/routes/backoffice/auth-navigation";

import {
  authenticateInstalledAppClient,
  exchangeBackofficeExecutionToken,
} from "./auth/backoffice-execution-token";
import {
  BackofficeUserTokenGrantForbiddenError,
  type BackofficeUserTokenAuthority,
} from "./auth/backoffice-user-token-grant";
import {
  createAccessCodeGate,
  createPasswordSignUpAccessCodeCheck,
} from "./auth/better-auth-access-codes";
import {
  createBackofficeAppSignInPlugins,
  UNUSED_EMAIL_CODE_PATHS,
} from "./auth/better-auth-app-sign-in";
import {
  applyBackofficeBetterAuthSchemaMigrations,
  BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION,
} from "./auth/better-auth-migrations";
import {
  createBackofficeAdminOAuthClient,
  getBackofficeCliOAuthConfig,
  initializeBackofficeCodemodeOAuthClient,
  getBackofficeOAuthClientFacts,
  initializeBackofficeOAuthResource,
  listBackofficeOAuthClients,
  resolveBackofficeOAuthExecutionPolicy,
  rotateBackofficeAdminOAuthClientSecret,
  updateBackofficeAdminOAuthClient,
} from "./auth/better-auth-oauth";
import { listBackofficeOAuthConsentPage } from "./auth/better-auth-oauth-consent";
import { createBackofficePasswordResetPlugin } from "./auth/better-auth-password-reset";
import { createBackofficeTokenPlugin } from "./auth/better-auth-plugin";
import {
  BACKOFFICE_ORGANIZATION_OWNER_ROLE,
  createBackofficeBetterAuthSchemaPlugins,
} from "./auth/better-auth-schema-plugins";
import {
  readAccountInvitations,
  readAccountProfile,
  readOrganization,
  readOrganizationInvitationPage,
  organizationHasOwner,
  readManagedOrganizationPage,
  readOrganizationMemberNumberedPage,
  readOrganizationMemberPage,
  readOrganizationMembership,
  readOrganizationPage,
} from "./auth/directory-queries";
import {
  findAdministeredMember,
  findManagingOrganization,
  findOrganizationAccess,
  listAccessibleOrganizations,
  readOrganizationRelations,
} from "./auth/organization-access";
import { type StoredDate, toDate } from "./auth/stored-date";
import {
  completeBetterAuthDurableHook,
  deleteBetterAuthDurableHooksForFixture,
  deleteRetainedBetterAuthDurableHooks,
  findNextBetterAuthDurableHookWakeAt,
  getBetterAuthDurableHook,
  insertBetterAuthDurableHook,
  installBetterAuthDurableHooks,
  listBetterAuthDurableHooks,
  listDueBetterAuthDurableHooks,
  markBetterAuthDurableHookProcessing,
  removeBetterAuthDurableHookTriggers,
  retryBetterAuthDurableHook,
  type BetterAuthDurableHookRow,
  type BetterAuthDurableHooksDatabase,
} from "./better-auth-durable-hooks";
import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";

type AuthOrganizationAutomationEventType =
  | typeof AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED
  | typeof AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED;

export type AuthDatabase = BetterAuthDurableHooksDatabase & {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: number | boolean;
    image: string | null;
    createdAt: StoredDate;
    updatedAt: StoredDate;
    role: string | null;
    banned: number | boolean | null;
    banReason: string | null;
    banExpires: StoredDate | null;
    jurisdiction: BackofficeJurisdiction | null;
    onboardedAt: StoredDate | null;
  };
  session: {
    id: string;
    token: string;
    userId: string;
    expiresAt: StoredDate;
    createdAt: StoredDate;
    updatedAt: StoredDate;
    ipAddress: string | null;
    userAgent: string | null;
    impersonatedBy: string | null;
    activeOrganizationId: string | null;
  };
  account: Record<string, unknown>;
  verification: Record<string, unknown>;
  jwks: Record<string, unknown>;
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    metadata: string | Record<string, unknown> | null;
    createdBy: string;
    managingOrganizationId: string | null;
    jurisdiction: BackofficeJurisdiction | null;
    createdAt: StoredDate;
    updatedAt: StoredDate | null;
  };
  member: {
    id: string;
    organizationId: string;
    userId: string;
    role: string;
    createdAt: StoredDate;
  };
  invitation: {
    id: string;
    organizationId: string;
    email: string;
    role: string;
    status: OrganizationInvitation["status"];
    inviterId: string;
    expiresAt: StoredDate;
    createdAt: StoredDate;
  };
};

type StoreUser = AuthDatabase["user"];
type StoreOrganization = AuthDatabase["organization"];
type StoreMember = AuthDatabase["member"];
type StoreInvitation = AuthDatabase["invitation"];
type AuthHookPayloads = {
  onUserCreated: { user: { id: string; email: string; name: string } };
  onUserEmailVerificationRequested: { user: { id: string; email: string } };
  onUserPasswordResetRequested: { verificationId: string; user: { id: string; email: string } };
  onOrganizationCreated: OrganizationHookPayload;
  onOrganizationUpdated: OrganizationHookPayload;
};
type AuthHookName = keyof AuthHookPayloads;
type StoredAuthHook = {
  [HookName in AuthHookName]: Omit<DurableHookQueueEntry, "hookName" | "payload"> & {
    hookName: HookName;
    payload: AuthHookPayloads[HookName];
    propagationContext: Readonly<Record<string, string>> | null;
  };
}[AuthHookName];

const AUTH_SCHEMA_VERSION_STORAGE_KEY = "backoffice-auth-schema-version";
const MAX_HOOK_ATTEMPTS = 10;
const AUTH_HOOK_BATCH_SIZE = 25;
const AUTH_HOOK_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
// Better Auth's default invitation lifetime, which members' own invitations get too.
const APP_INVITATION_LIFETIME_MS = 48 * 60 * 60 * 1_000;
// Better Auth's default limit on an organization's pending invitations, which members' own
// invitations are held to too.
const PENDING_INVITATION_LIMIT = 100;

const grantBackofficeAdminInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
});

async function adminGrantTokensMatch(
  providedToken: string,
  configuredToken: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(providedToken)),
    crypto.subtle.digest("SHA-256", encoder.encode(configuredToken)),
  ]);
  const providedBytes = new Uint8Array(providedDigest);
  const configuredBytes = new Uint8Array(configuredDigest);
  let difference = 0;
  for (let index = 0; index < providedBytes.length; index += 1) {
    difference |= providedBytes[index] ^ configuredBytes[index];
  }
  return difference === 0;
}

const toIsoString = (date: Date | string): string =>
  date instanceof Date ? date.toISOString() : new Date(date).toISOString();
const normalizeRole = (role: string | null | undefined): Role =>
  role?.split(",").includes("admin") ? "admin" : "user";
const isRejotEmail = (email: string): boolean => email.trim().toLowerCase().endsWith("@rejot.dev");
const normalizeBoolean = (value: boolean | number | null | undefined): boolean =>
  value === true || value === 1;

const parseOrganizationMetadata = (
  organizationId: string,
  metadata: string | Record<string, unknown> | null,
): Record<string, unknown> | null => {
  if (!metadata) {
    return null;
  }
  if (typeof metadata !== "string") {
    return metadata;
  }

  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("Organization metadata must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Stored metadata for organization '${organizationId}' is invalid.`, {
      cause: error,
    });
  }
};

const toAuthUser = (user: StoreUser): AuthUser => ({
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: normalizeBoolean(user.emailVerified),
  role: normalizeRole(user.role),
  banned: normalizeBoolean(user.banned),
  jurisdiction: user.jurisdiction,
  onboardedAt: user.onboardedAt === null ? null : toDate(user.onboardedAt),
  createdAt: toDate(user.createdAt),
  updatedAt: toDate(user.updatedAt),
});

const toOrganization = (organization: StoreOrganization): Organization => ({
  id: organization.id,
  name: organization.name,
  slug: organization.slug,
  logoUrl: organization.logo,
  metadata: parseOrganizationMetadata(organization.id, organization.metadata),
  createdBy: organization.createdBy,
  jurisdiction: organization.jurisdiction,
  createdAt: toDate(organization.createdAt),
  updatedAt: toDate(organization.updatedAt ?? organization.createdAt),
  deletedAt: null,
});

type StoredOrganizationHookPayload = {
  organization: Omit<Organization, "createdAt" | "updatedAt"> & {
    createdAt: Exclude<StoredDate, Date>;
    updatedAt: Exclude<StoredDate, Date>;
  };
  actor: null;
};

function deserializeBetterAuthDurableHook(row: BetterAuthDurableHookRow): StoredAuthHook {
  const common = {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastAttemptAt: row.lastAttemptAt === null ? null : new Date(row.lastAttemptAt).toISOString(),
    nextRetryAt: row.nextRetryAt === null ? null : new Date(row.nextRetryAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    error: row.error,
    propagationContext:
      row.propagationContext === null
        ? null
        : (JSON.parse(row.propagationContext) as Readonly<Record<string, string>>),
  };
  if (row.hookName === "onUserCreated") {
    return {
      ...common,
      hookName: row.hookName,
      payload: JSON.parse(row.payload) as AuthHookPayloads["onUserCreated"],
    };
  }
  if (row.hookName === "onUserEmailVerificationRequested") {
    return {
      ...common,
      hookName: row.hookName,
      payload: JSON.parse(row.payload) as AuthHookPayloads["onUserEmailVerificationRequested"],
    };
  }

  if (row.hookName === "onUserPasswordResetRequested") {
    return {
      ...common,
      hookName: row.hookName,
      payload: JSON.parse(row.payload) as AuthHookPayloads["onUserPasswordResetRequested"],
    };
  }

  const stored = JSON.parse(row.payload) as StoredOrganizationHookPayload;
  return {
    ...common,
    hookName: row.hookName,
    payload: {
      organization: {
        ...stored.organization,
        createdAt: toDate(stored.organization.createdAt),
        updatedAt: toDate(stored.organization.updatedAt),
      },
      actor: null,
    },
  };
}

const buildOrganizationPayload = (organization: Organization) => ({
  organization: {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    logoUrl: organization.logoUrl ?? null,
    metadata: organization.metadata ?? null,
    createdBy: organization.createdBy,
    createdAt: toIsoString(organization.createdAt),
    updatedAt: toIsoString(organization.updatedAt),
    deletedAt: organization.deletedAt ? toIsoString(organization.deletedAt) : null,
  },
});

const buildAuthInitiator = (actor: UserSummary | null) =>
  actor
    ? {
        scope: "internal" as const,
        type: "user" as const,
        id: actor.id,
        role: "initiator" as const,
      }
    : AUTOMATION_SYSTEM_INITIATOR;

const dispatchOrganizationEvent = async (
  runtime: BackofficeRuntimeServices,
  eventType: AuthOrganizationAutomationEventType,
  payload: OrganizationHookPayload,
  context: AuthHookContext,
) => {
  const { organization } = payload;
  const occurredAt = toIsoString(
    eventType === AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED
      ? organization.createdAt
      : organization.updatedAt,
  );
  await runtime.objects.automations.singleton().commands.ingestEvent(
    {
      id: context.hookId.toString(),
      scopeRestriction: null,
      scope: { kind: "system" },
      source: AUTH_AUTOMATION_SOURCE,
      eventType,
      occurredAt,
      payload: buildOrganizationPayload(organization),
      actors: {
        initiator: buildAuthInitiator(payload.actor),
        principal: null,
        delegation: [],
      },
      subject: { scope: backofficeOrganizationContextScope(organization) },
      causation: { kind: "origin" },
    },
    { propagationContext: context.capturePropagationContext() },
  );
};

export const createOrganizationAutomationHooks = (
  runtime: BackofficeRuntimeServices,
): OrganizationHooks => ({
  async onOrganizationCreated(payload, context) {
    await dispatchOrganizationEvent(
      runtime,
      AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED,
      payload,
      context,
    );
  },
  async onOrganizationUpdated(payload, context) {
    await dispatchOrganizationEvent(
      runtime,
      AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED,
      payload,
      context,
    );
  },
});

function resolveAuthBaseUrl(request: Request): string {
  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedProto === "http" || forwardedProto === "https") {
    requestUrl.protocol = `${forwardedProto}:`;
  }
  // Preserve the selected host: OAuth issuance and execution RPCs must agree on the issuer.
  return requestUrl.origin;
}

function listTrustedAuthOrigins(baseURL: string, publicOrigin: string | null): string[] {
  const baseUrl = new URL(baseURL);
  const origins = new Set([baseUrl.origin]);
  // Email links can use the configured public origin while requests arrive over a local proxy.
  if (publicOrigin !== null) {
    origins.add(publicOrigin);
  }
  if (
    baseUrl.protocol === "http:" &&
    (baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "localhost")
  ) {
    const loopbackAlias = new URL(baseUrl);
    loopbackAlias.hostname = baseUrl.hostname === "localhost" ? "127.0.0.1" : "localhost";
    origins.add(loopbackAlias.origin);
  }
  return [...origins];
}

type BetterAuthInstance = Pick<ReturnType<typeof betterAuth>, "handler" | "options" | "$context">;
type BetterAuthContext = Awaited<ReturnType<typeof betterAuth>["$context"]>;
type CreateOrganizationEndpoint = (input: {
  body: { name: string; slug: string; userId: string };
}) => Promise<{ id: string; slug: string }>;
type AddOrganizationMemberEndpoint = (input: {
  body: { userId: string; role: string[]; organizationId: string };
}) => Promise<StoreMember>;
type OrganizationAdminEndpoints = {
  createOrganization: CreateOrganizationEndpoint;
  addMember: AddOrganizationMemberEndpoint;
};

/** Session-bound organization endpoints; callers act as one live user. */
type OrganizationUserEndpoints = {
  createInvitation(input: {
    headers: Headers;
    body: { organizationId: string; email: string; role: string[] };
  }): Promise<StoreInvitation>;
  acceptInvitation(input: {
    headers: Headers;
    body: { invitationId: string };
  }): Promise<{ invitation: StoreInvitation; member: StoreMember }>;
};

function toOrganizationInvitationRecord(invitation: StoreInvitation): OrganizationInvitationRecord {
  return {
    invitationId: invitation.id,
    organizationId: invitation.organizationId,
    email: invitation.email,
    roles: splitOrganizationRoles(invitation.role),
    expiresAt: toIsoString(toDate(invitation.expiresAt)),
    createdAt: toIsoString(toDate(invitation.createdAt)),
  };
}

function getOrganizationUserEndpoints(auth: BetterAuthInstance): OrganizationUserEndpoints {
  const api: unknown = "api" in auth ? auth.api : null;
  if (
    typeof api !== "object" ||
    api === null ||
    !("createInvitation" in api) ||
    typeof api.createInvitation !== "function" ||
    !("acceptInvitation" in api) ||
    typeof api.acceptInvitation !== "function"
  ) {
    throw new Error("Better Auth organization invitation endpoints are not configured.");
  }
  return api as OrganizationUserEndpoints;
}

function hasOrganizationAdminEndpoints(
  auth: BetterAuthInstance,
): auth is BetterAuthInstance & { api: OrganizationAdminEndpoints } {
  if (!("api" in auth) || typeof auth.api !== "object" || auth.api === null) {
    return false;
  }
  return (
    "createOrganization" in auth.api &&
    typeof auth.api.createOrganization === "function" &&
    "addMember" in auth.api &&
    typeof auth.api.addMember === "function"
  );
}

function getOrganizationAdminEndpoints(auth: BetterAuthInstance): OrganizationAdminEndpoints {
  if (!hasOrganizationAdminEndpoints(auth)) {
    throw new Error("Better Auth organization administration endpoints are not configured.");
  }
  return auth.api;
}

const getAuthContext = async (auth: BetterAuthInstance): Promise<BetterAuthContext> =>
  await auth.$context;

type BetterAuthAdapter = BetterAuthContext["adapter"];
type BetterAuthTransaction = Parameters<Parameters<BetterAuthAdapter["transaction"]>[0]>[0];

/** The address's pending invitation, when it is for the same roles. */
function samePendingInvitation(
  pending: StoreInvitation,
  input: Pick<CreateInvitationInput, "email" | "roles">,
): AppProvisioningResult<OrganizationInvitationRecord> {
  const pendingRoles = new Set(splitOrganizationRoles(pending.role));
  const requestedRoles = new Set(input.roles);
  if (
    pendingRoles.size !== requestedRoles.size ||
    [...requestedRoles].some((role) => !pendingRoles.has(role))
  ) {
    return {
      ok: false,
      error: { code: "conflict", message: `'${input.email}' is already invited with other roles.` },
    };
  }
  return { ok: true, value: toOrganizationInvitationRecord(pending) };
}

/**
 * The organization's pending owner invitation to `email`, or a new one from `inviterId`; null once
 * it has an owner, and `invited-someone-else` while one is pending for another address. Better
 * Auth's invitation endpoint only lets members invite, so the row is written here.
 */
async function ensureOwnerInvitation(
  transaction: BetterAuthTransaction,
  input: { organizationId: string; email: string; inviterId: string; now: Date },
): Promise<StoreInvitation | null | "invited-someone-else"> {
  if (await organizationHasOwner(transaction, input.organizationId)) {
    return null;
  }
  // Roles hold "owner" only for owners, as for members.
  const pending = await transaction.findOne<StoreInvitation>({
    model: "invitation",
    where: [
      { field: "organizationId", value: input.organizationId },
      { field: "status", value: "pending" },
      { field: "expiresAt", operator: "gt", value: input.now },
      { field: "role", operator: "contains", value: BACKOFFICE_ORGANIZATION_OWNER_ROLE },
    ],
  });
  if (pending) {
    return pending.email === input.email ? pending : "invited-someone-else";
  }
  return await transaction.create<StoreInvitation>({
    model: "invitation",
    data: {
      organizationId: input.organizationId,
      email: input.email,
      role: BACKOFFICE_ORGANIZATION_OWNER_ROLE,
      status: "pending",
      inviterId: input.inviterId,
      expiresAt: new Date(input.now.getTime() + APP_INVITATION_LIFETIME_MS),
      createdAt: input.now,
    },
  });
}

const findStoreUser = async (
  adapter: BetterAuthAdapter,
  userId: string,
): Promise<StoreUser | null> =>
  await adapter.findOne<StoreUser>({
    model: "user",
    where: [{ field: "id", value: userId }],
  });

const findStoreUserByEmail = async (
  adapter: BetterAuthAdapter,
  userEmail: string,
): Promise<StoreUser | null> =>
  await adapter.findOne<StoreUser>({
    model: "user",
    where: [{ field: "email", value: userEmail.trim().toLowerCase() }],
  });

async function resolveBackofficeUserTokenGrant(
  adapter: BetterAuthAdapter,
  database: Kysely<AuthDatabase>,
  input: {
    userId: string;
    scope: BackofficeContextScope | null;
    organizationSelection: "preferred" | "required";
  },
): Promise<BackofficeUserTokenAuthority> {
  const storedUser = await findStoreUser(adapter, input.userId);
  if (!storedUser || normalizeBoolean(storedUser.banned)) {
    throw new BackofficeUserTokenGrantForbiddenError(
      "This user cannot receive a Backoffice access token.",
    );
  }

  const globalRole = normalizeRole(storedUser.role);
  const personalScope = backofficePersonalScope(storedUser);
  if (input.scope?.kind === "system") {
    if (globalRole !== "admin") {
      throw new BackofficeUserTokenGrantForbiddenError(
        "The requested system scope is not available to this user.",
      );
    }
    return {
      userId: storedUser.id,
      email: storedUser.email,
      globalRole,
      personalScope,
      scope: input.scope,
      organization: null,
    };
  }

  // What a user owns is available to that user and to administrators of their organizations.
  const requestedOwner = input.scope && backofficeScopeRootOwner(input.scope);
  if (input.scope && requestedOwner?.kind === "user") {
    const ownerScope =
      requestedOwner.userId === storedUser.id
        ? personalScope
        : await findAdministeredMember(database, {
            administratorId: storedUser.id,
            memberId: requestedOwner.userId,
          }).then(
            (member) =>
              member &&
              ({
                kind: "user",
                userId: member.userId,
                jurisdiction: member.jurisdiction,
              } as const),
          );
    // A scope naming the user in another jurisdiction names objects that are not theirs.
    if (!ownerScope || !backofficeContextScopesEqual(ownerScope, requestedOwner)) {
      throw new BackofficeUserTokenGrantForbiddenError(
        "The requested user scope is not available to this user.",
      );
    }
    return {
      userId: storedUser.id,
      email: storedUser.email,
      globalRole,
      personalScope,
      scope: input.scope,
      organization: null,
    };
  }

  // An organization's own members list theirs first, so a user's default is one they belong to.
  const memberships = await listAccessibleOrganizations(database, storedUser.id);

  const requestedOrganization = input.scope ? backofficeScopeOrganization(input.scope) : null;
  const requestedOrganizationId = requestedOrganization?.orgId ?? null;
  const defaultMembership = memberships[0];
  if (!defaultMembership) {
    if (requestedOrganizationId && input.organizationSelection === "required") {
      throw new BackofficeUserTokenGrantForbiddenError(
        "The requested Backoffice scope is not available to this user.",
      );
    }
    // Organizations are created by their users; until then a user works in their own scope.
    return {
      userId: storedUser.id,
      email: storedUser.email,
      globalRole,
      personalScope,
      scope: personalScope,
      organization: null,
    };
  }

  const requestedMembership = requestedOrganization
    ? memberships.find(
        ({ organization }) =>
          organization.id === requestedOrganization.orgId &&
          organization.jurisdiction === requestedOrganization.jurisdiction,
      )
    : null;
  if (
    requestedOrganizationId &&
    !requestedMembership &&
    input.organizationSelection === "required"
  ) {
    throw new BackofficeUserTokenGrantForbiddenError(
      "The requested Backoffice scope is not available to this user.",
    );
  }

  const selectedMembership = requestedMembership ?? defaultMembership;
  const selectedScope: BackofficeContextScope =
    requestedMembership && input.scope
      ? input.scope
      : backofficeOrganizationContextScope(selectedMembership.organization);

  return {
    userId: storedUser.id,
    email: storedUser.email,
    globalRole,
    personalScope,
    scope: selectedScope,
    organization: {
      id: selectedMembership.organization.id,
      slug: selectedMembership.organization.slug,
      jurisdiction: selectedMembership.organization.jurisdiction,
      roles: selectedMembership.roles,
    },
  };
}

const buildBackofficeMe = async (
  adapter: BetterAuthAdapter,
  database: Kysely<AuthDatabase>,
  input: { userId: string; activeOrganizationId: string | null },
): Promise<BackofficeMeData | null> => {
  const storedUser = await findStoreUser(adapter, input.userId);
  if (!storedUser) {
    return null;
  }

  const mappedOrganizations = (await listAccessibleOrganizations(database, input.userId)).map(
    ({ organization, roles, through }) => ({
      organization: toOrganization(organization),
      roles,
      through:
        through.kind === "membership"
          ? through
          : {
              kind: "managing-organization" as const,
              organization: {
                id: through.organization.id,
                name: through.organization.name,
                slug: through.organization.slug,
              },
            },
    }),
  );

  return {
    user: toAuthUser(storedUser),
    organizations: mappedOrganizations,
    activeOrganizationId: input.activeOrganizationId,
    activeOrganization:
      mappedOrganizations.find((entry) => entry.organization.id === input.activeOrganizationId) ??
      null,
  };
};

type AuthObjectEnv = Pick<
  BackofficeRuntimeEnv,
  | "AUTH_ACCESS_TOKEN_SECRET"
  | "AUTH_ADMIN_GRANT_TOKEN"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
>;

export class AuthObject implements AuthCommands {
  readonly #env: AuthObjectEnv;
  readonly #state: BackofficeObjectState;
  readonly #runtime: BackofficeRuntimeServices;
  readonly #passwordResetPublicBaseUrl: string | null;
  readonly #database: Kysely<AuthDatabase>;
  readonly #ready: Promise<void>;
  readonly #authByBaseUrl = new Map<string, BetterAuthInstance>();
  // Shared per origin, so concurrent first requests await one creation instead of racing on the
  // resource's unique identifier.
  readonly #oauthResourceInitializations = new Map<string, Promise<void>>();
  readonly #rateLimits = new Map<string, { key: string; count: number; windowStartedAt: number }>();
  #adminGrantQueue: Promise<void> = Promise.resolve();
  #processingHooks: Promise<void> | null = null;

  constructor({
    state,
    env,
    runtime,
    database,
  }: {
    state: BackofficeObjectState;
    env: AuthObjectEnv;
    runtime: BackofficeRuntimeServices;
    database?: Kysely<AuthDatabase>;
  }) {
    this.#env = env;
    this.#state = state;
    this.#runtime = runtime;
    const passwordResetPublicBaseUrl = z
      .url({ protocol: /^https?$/ })
      .safeParse(runtime.config.docsPublicBaseUrl);
    // Recovery needs a public origin, but missing mail configuration must not disable sign-in.
    this.#passwordResetPublicBaseUrl = passwordResetPublicBaseUrl.success
      ? new URL(passwordResetPublicBaseUrl.data).origin
      : null;

    if (!database && !(state.storage as DurableObjectStorage & { sql?: unknown }).sql) {
      throw new Error("Better Auth requires a SQLite database.");
    }
    this.#database =
      database ??
      new Kysely<AuthDatabase>({
        dialect: new DurableObjectDialect({
          ctx: state as DurableObjectState,
          queryInstrumentation: null,
        }),
      });

    this.#ready = state.blockConcurrencyWhile(async () => {
      const installedSchemaVersion = await state.storage.get<string>(
        AUTH_SCHEMA_VERSION_STORAGE_KEY,
      );
      if (installedSchemaVersion !== BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION) {
        await this.#database.transaction().execute(async (transaction) => {
          await removeBetterAuthDurableHookTriggers<AuthDatabase>(transaction);
          await applyBackofficeBetterAuthSchemaMigrations<AuthDatabase>(
            transaction,
            installedSchemaVersion ?? null,
          );
          await installBetterAuthDurableHooks<AuthDatabase>(transaction);
        });
        // Installing creates the Codemode client once; activations then skip building a Better
        // Auth instance for it, and the paths that hand the client out still ensure it exists.
        await initializeBackofficeCodemodeOAuthClient(this.#getAuth("http://localhost"));
        await state.storage.put(
          AUTH_SCHEMA_VERSION_STORAGE_KEY,
          BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION,
        );
      }

      if (!runtime.config.authEmailVerification.enabled) {
        // New users arrive verified while verification is off; this covers those who signed up
        // while it was on, so none is left waiting for an email that will never come.
        await this.#database
          .updateTable("user")
          .set({ emailVerified: 1 })
          .where("emailVerified", "=", 0)
          .execute();
      }

      const nextHookWakeAt = await findNextBetterAuthDurableHookWakeAt(this.#database, {
        wakeImmediately: false,
      });
      if (nextHookWakeAt !== null) {
        await this.#state.storage.setAlarm(nextHookWakeAt);
      }
    });
  }

  async #isUserAdministrator(userId: string): Promise<boolean> {
    const user = await this.#database
      .selectFrom("user")
      .select(["role", "banned"])
      .where("id", "=", userId)
      .executeTakeFirst();
    return (
      user !== undefined && normalizeRole(user.role) === "admin" && !normalizeBoolean(user.banned)
    );
  }

  #consumeRateLimit(key: string, rule: { window: number; max: number }) {
    const now = Date.now();
    const windowInMilliseconds = rule.window * 1_000;
    const current = this.#rateLimits.get(key);
    if (!current || now - current.windowStartedAt >= windowInMilliseconds) {
      this.#rateLimits.set(key, { key, count: 1, windowStartedAt: now });
      return { allowed: true, retryAfter: null };
    }
    if (current.count >= rule.max) {
      return {
        allowed: false,
        retryAfter: Math.ceil((current.windowStartedAt + windowInMilliseconds - now) / 1_000),
      };
    }
    this.#rateLimits.set(key, { ...current, count: current.count + 1 });
    return { allowed: true, retryAfter: null };
  }

  #createOptions(baseURL: string): BetterAuthOptions {
    const runtime = this.#runtime;
    const emailVerification = runtime.config.authEmailVerification;
    const secret = resolveLiveAccessTokenSecret(this.#env, import.meta.env.MODE === "development");
    // Follow the origin, not the build mode: `pnpm preview` serves a production build over HTTP.
    const secureCookies = new URL(baseURL).protocol === "https:";
    const objects = runtime.objects;
    const schemaPlugins = createBackofficeBetterAuthSchemaPlugins({
      baseURL,
      isUserAdministrator: async (userId) => await this.#isUserAdministrator(userId),
      listFirstPartyOAuthClientIds: async () =>
        await objects.apps.singleton().commands.listFirstPartyOAuthClientIds(),
      organizationHooks: {
        async beforeCreateOrganization({ organization: nextOrganization, user }) {
          return {
            data: {
              ...nextOrganization,
              createdBy: user.id,
              updatedAt: new Date(),
            },
          };
        },
        async beforeUpdateOrganization({ organization: patch }) {
          // Page URLs name organizations by slug, so a changed slug would break every link to one.
          if (patch.slug !== undefined) {
            throw new APIError("BAD_REQUEST", {
              message: "An organization's slug cannot be changed.",
            });
          }
          // Its Durable Objects stay where they were made, so moving it would lose them.
          if ("jurisdiction" in patch) {
            throw new APIError("BAD_REQUEST", {
              message: "An organization's jurisdiction cannot be changed.",
            });
          }
          return { data: { ...patch, updatedAt: new Date() } };
        },
      },
    });

    const backofficeTokenPlugin = createBackofficeTokenPlugin({
      secureCookies,
      resolveBackofficeUserTokenGrant: async (adapter, input) =>
        await resolveBackofficeUserTokenGrant(adapter, this.#database, input),
    });
    const accessCodePlugins = runtime.config.signUpAccessCodesRequired
      ? [
          createPasswordSignUpAccessCodeCheck({
            checkAccessCode: async (code) =>
              await runtime.objects.otp.singleton().commands.checkAccessCode({ code }),
          }),
        ]
      : [];
    const appSignInPlugins = createBackofficeAppSignInPlugins({
      findFirstPartyBranding: async (clientId) => {
        const app = await runtime.objects.apps
          .singleton()
          .commands.getAppByOAuthClientId({ oauthClientId: clientId });
        return app?.trust.kind === "first-party" ? app.trust.branding : null;
      },
      sendSignInCode: async (input) => {
        // Keep email rendering and formatting dependencies out of ordinary Auth operations.
        const { buildAppSignInCodeEmail } = await import("@/transactional-emails/app-sign-in-code");
        await runtime.objects.resend
          .singleton()
          .commands.queueEmail(await buildAppSignInCodeEmail(input), {
            idempotencyKey: `auth:app-sign-in-code:${crypto.randomUUID()}`,
            senderName: input.branding.displayName,
          });
      },
    });

    const options = {
      appName: "Fragno Backoffice",
      baseURL,
      basePath: "/api/auth",
      secret,
      trustedOrigins: listTrustedAuthOrigins(baseURL, this.#passwordResetPublicBaseUrl),
      onAPIError: {
        errorURL: `${baseURL}${BACKOFFICE_LOGIN_PATH}`,
      },
      database: { db: this.#database, type: "sqlite" as const, transaction: true },
      emailAndPassword: {
        enabled: true,
        minPasswordLength: BACKOFFICE_PASSWORD_MIN_LENGTH,
        maxPasswordLength: BACKOFFICE_PASSWORD_MAX_LENGTH,
        requireEmailVerification: emailVerification.enabled,
        resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_LIFETIME_SECONDS,
        revokeSessionsOnPasswordReset: true,
        sendResetPassword: async function passwordResetDeliveryRecordedByTrigger() {
          // Better Auth requires this callback to enable recovery. The verification INSERT trigger
          // records delivery atomically; a callback enqueue would leave a crash window after issuance.
        },
      },
      user: runtime.config.signUpAccessCodesRequired
        ? {
            validateUserInfo: createAccessCodeGate({
              redeemAccessCode: async (redemption) =>
                await runtime.objects.otp.singleton().commands.redeemAccessCode(redemption),
            }),
          }
        : {},
      emailVerification: {
        // User creation is observed transactionally by the SQLite trigger. The resulting durable
        // hook requests verification delivery; Better Auth must not start it as a background task.
        sendOnSignUp: false,
        sendOnSignIn: false,
        sendVerificationEmail: async (
          { user }: { user: { id: string; email: string } },
          request?: Request,
        ) => {
          if (!emailVerification.enabled) {
            return;
          }
          await this.#insertHook(
            "onUserEmailVerificationRequested",
            { user: { id: user.id, email: user.email } },
            request ? extractW3CRequestPropagationContext(request.headers) : null,
          );
        },
      },
      socialProviders:
        this.#env.GITHUB_CLIENT_ID && this.#env.GITHUB_CLIENT_SECRET
          ? {
              github: {
                clientId: this.#env.GITHUB_CLIENT_ID,
                clientSecret: this.#env.GITHUB_CLIENT_SECRET,
              },
            }
          : {},
      account: {
        encryptOAuthTokens: true,
        accountLinking: { enabled: true, trustedProviders: ["github"] },
      },
      session: {
        expiresIn: 60 * 60 * 24 * 7,
        updateAge: 60 * 60 * 24,
      },
      rateLimit: {
        enabled: true,
        // JWKS is public key material fetched by every application request when a Worker isolate
        // has a cold cache. Applying per-IP auth throttling here can log out a valid user during a
        // burst of concurrent route loaders.
        customRules: { "/jwks": false },
        customStorage: {
          consume: async (key: string, rule: { window: number; max: number }) =>
            this.#consumeRateLimit(key, rule),
        },
      },
      disabledPaths: ["/token", ...UNUSED_EMAIL_CODE_PATHS],
      advanced: {
        // Only Cloudflare's header is trusted; clients can write X-Forwarded-For themselves.
        ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
        // Better Auth otherwise skips origin validation under test, hiding callback mismatches.
        disableOriginCheck: false,
        useSecureCookies: secureCookies,
        defaultCookieAttributes: { path: "/api/auth" },
        cookies: {
          session_token: { attributes: { path: "/" } },
        },
      },
      // Never add Better Auth `after` database hooks here. They run outside the mutation
      // transaction; lifecycle side effects must be recorded atomically by SQLite triggers and
      // delivered through better_auth_hooks. Keep this section limited to synchronous `before`
      // validation.
      databaseHooks: {
        user: {
          create: {
            before: async (user: Record<string, unknown> & { email: string }) => ({
              data: {
                ...user,
                // Without verification nothing would ever verify an address, so every address
                // counts as verified and no feature waits for a proof that cannot come.
                ...(emailVerification.enabled ? {} : { emailVerified: true }),
                role:
                  isRejotEmail(user.email) && import.meta.env.MODE === "development"
                    ? "admin"
                    : "user",
              },
            }),
          },
        },
      },
      plugins: [
        ...schemaPlugins,
        backofficeTokenPlugin,
        // After the OAuth Provider, which verifies the app's request this needs.
        ...accessCodePlugins,
        ...appSignInPlugins,
        createBackofficePasswordResetPlugin({
          publicBaseUrl: this.#passwordResetPublicBaseUrl,
          acceptRequest: (email) =>
            this.#consumeRateLimit(`password-reset-email:${email}`, { window: 60, max: 1 }).allowed,
        }),
      ],
    } satisfies BetterAuthOptions;

    return options;
  }

  async #initializeOAuthResource(auth: BetterAuthInstance, baseURL: string): Promise<void> {
    let initialization = this.#oauthResourceInitializations.get(baseURL);
    if (!initialization) {
      initialization = initializeBackofficeOAuthResource(auth, baseURL);
      this.#oauthResourceInitializations.set(baseURL, initialization);
      // A failed attempt must not be remembered; the next request retries.
      initialization.catch(() => this.#oauthResourceInitializations.delete(baseURL));
    }
    await initialization;
  }

  #getAuth(baseURL: string) {
    // HTTP handlers and RPC token exchanges must agree on the issuer for loopback aliases.
    const origin = resolveAuthBaseUrl(new Request(baseURL));
    let auth = this.#authByBaseUrl.get(origin);
    if (!auth) {
      auth = betterAuth(this.#createOptions(origin));
      this.#authByBaseUrl.set(origin, auth);
    }
    return auth;
  }

  async #scheduleNextHookAlarm(): Promise<void> {
    const nextWakeAt = await findNextBetterAuthDurableHookWakeAt(this.#database, {
      wakeImmediately: false,
    });
    if (nextWakeAt === null) {
      return;
    }
    const existingAlarm = await this.#state.storage.getAlarm();
    if (existingAlarm === null || existingAlarm > nextWakeAt) {
      await this.#state.storage.setAlarm(nextWakeAt);
    }
  }

  async #insertHook<HookName extends AuthHookName>(
    hookName: HookName,
    payload: AuthHookPayloads[HookName],
    propagationContext: Readonly<Record<string, string>> | null,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await insertBetterAuthDurableHook(this.#database, {
      id,
      hookName,
      payload: JSON.stringify(payload),
      maxAttempts: MAX_HOOK_ATTEMPTS,
      propagationContext: propagationContext === null ? null : JSON.stringify(propagationContext),
    });
    return id;
  }

  async #enqueueHook<HookName extends AuthHookName>(
    hookName: HookName,
    payload: AuthHookPayloads[HookName],
    propagationContext: Readonly<Record<string, string>> | null,
  ): Promise<string> {
    const id = await this.#insertHook(hookName, payload, propagationContext);
    await this.#scheduleNextHookAlarm();
    return id;
  }

  async enqueueEmailVerificationHook(
    input: { userId: string; email: string },
    propagationContext: Readonly<Record<string, string>> | null = null,
  ): Promise<string> {
    return await this.#enqueueHook(
      "onUserEmailVerificationRequested",
      { user: { id: input.userId, email: input.email } },
      propagationContext,
    );
  }

  async enqueueOrganizationHook(
    hookName: "onOrganizationCreated" | "onOrganizationUpdated",
    payload: OrganizationHookPayload,
    propagationContext: Readonly<Record<string, string>> | null = null,
  ): Promise<string> {
    return await this.#enqueueHook(hookName, payload, propagationContext);
  }

  async #executeHook(record: StoredAuthHook) {
    const context: AuthHookContext = {
      hookId: record.id,
      capturePropagationContext: () => record.propagationContext,
    };
    if (record.hookName === "onUserCreated") {
      // Users can arrive with a verified address, such as those a first-party app provisions.
      const user = await findStoreUser((await this.#authContext()).adapter, record.payload.user.id);
      if (
        this.#runtime.config.authEmailVerification.enabled &&
        user &&
        !normalizeBoolean(user.emailVerified)
      ) {
        const verificationHookId = `email-verification-${record.payload.user.id}`;
        const existingVerificationHook = await getBetterAuthDurableHook(
          this.#database,
          verificationHookId,
        );
        if (!existingVerificationHook) {
          await insertBetterAuthDurableHook(this.#database, {
            id: verificationHookId,
            hookName: "onUserEmailVerificationRequested",
            payload: JSON.stringify({
              user: { id: record.payload.user.id, email: record.payload.user.email },
            }),
            maxAttempts: MAX_HOOK_ATTEMPTS,
            propagationContext:
              record.propagationContext === null ? null : JSON.stringify(record.propagationContext),
          });
        }
      }
      return;
    }
    if (record.hookName === "onUserPasswordResetRequested") {
      const { adapter, internalAdapter } = await this.#authContext();
      const verification = await adapter.findOne<{
        identifier: string;
        value: string;
        expiresAt: Date;
      }>({
        model: "verification",
        where: [{ field: "id", value: record.payload.verificationId }],
      });
      // A delayed retry must not deliver a link that was already consumed or expired.
      if (!verification || verification.expiresAt <= new Date()) {
        return;
      }
      const user = await internalAdapter.findUserById(verification.value);
      if (!user || user.email !== record.payload.user.email) {
        return;
      }
      const publicBaseUrl = this.#passwordResetPublicBaseUrl;
      if (!publicBaseUrl) {
        throw new Error("Password reset requires DOCS_PUBLIC_BASE_URL.");
      }
      const resetUrl = new URL("/backoffice/reset-password", publicBaseUrl);
      resetUrl.searchParams.set("token", verification.identifier.slice("reset-password:".length));
      const { buildUserPasswordResetEmail } =
        await import("@/transactional-emails/user-password-reset");
      await this.#runtime.objects.resend.singleton().commands.queueEmail(
        await buildUserPasswordResetEmail({
          email: user.email,
          resetUrl: resetUrl.href,
          publicBaseUrl,
        }),
        { idempotencyKey: `auth:password-reset:${record.id}`, senderName: null },
      );
      return;
    }
    if (record.hookName === "onUserEmailVerificationRequested") {
      const payload = record.payload;
      const emailVerification = this.#runtime.config.authEmailVerification;
      if (!emailVerification.enabled) {
        return;
      }
      const verification = await this.#runtime.objects.otp
        .singleton()
        .commands.issueEmailVerification({
          userId: payload.user.id,
          email: payload.user.email,
          publicBaseUrl: emailVerification.publicBaseUrl,
          requestId: record.id,
        });
      if (!verification.deliverable) {
        return;
      }
      const { buildUserEmailVerificationEmail } =
        await import("@/transactional-emails/user-email-verification");
      await this.#runtime.objects.resend.singleton().commands.queueEmail(
        await buildUserEmailVerificationEmail({
          email: payload.user.email,
          verificationUrl: verification.url,
          expiresInHours: verification.expiresInHours,
          publicBaseUrl: emailVerification.publicBaseUrl,
        }),
        { idempotencyKey: `auth:email-verification:${record.id}`, senderName: null },
      );
      return;
    }
    const payload = record.payload;
    const hooks = createOrganizationAutomationHooks(this.#runtime);
    if (record.hookName === "onOrganizationCreated") {
      await hooks.onOrganizationCreated?.(payload, context);
    } else {
      await hooks.onOrganizationUpdated?.(payload, context);
    }
  }

  async #processDatabaseHooks(): Promise<number | null> {
    const rows = await listDueBetterAuthDurableHooks(this.#database, {
      limit: AUTH_HOOK_BATCH_SIZE,
    });
    for (const row of rows) {
      await markBetterAuthDurableHookProcessing(this.#database, { id: row.id });
      try {
        await this.#executeHook(deserializeBetterAuthDurableHook(row));
        await completeBetterAuthDurableHook(this.#database, { id: row.id });
      } catch (error) {
        await retryBetterAuthDurableHook(this.#database, {
          id: row.id,
          retryDelayMs: Math.min(60_000, 1_000 * 2 ** Math.max(0, row.attempts)),
          error: error instanceof Error ? error.message : String(error),
          terminal: row.attempts + 1 >= row.maxAttempts,
        });
      }
    }

    const deleted = await deleteRetainedBetterAuthDurableHooks(this.#database, {
      retentionMs: AUTH_HOOK_RETENTION_MS,
    });
    return await findNextBetterAuthDurableHookWakeAt(this.#database, {
      wakeImmediately: rows.length === AUTH_HOOK_BATCH_SIZE || deleted === 100,
    });
  }

  async #processHooks(): Promise<void> {
    if (this.#processingHooks) {
      await this.#processingHooks;
      return;
    }
    this.#processingHooks = (async () => {
      const nextWakeAt = await this.#processDatabaseHooks();
      if (nextWakeAt === null) {
        await this.#state.storage.deleteAlarm();
      } else {
        await this.#state.storage.setAlarm(nextWakeAt);
      }
    })();
    try {
      await this.#processingHooks;
    } finally {
      this.#processingHooks = null;
    }
  }

  async alarm() {
    await this.#ready;
    await this.#processHooks();
  }

  async getDurableHookQueue(
    options: DurableHookQueueOptions = {},
  ): Promise<DurableHookQueueResponse> {
    const pageSize = Math.min(200, Math.max(1, options.pageSize ?? 50));
    const hooks = (
      await listBetterAuthDurableHooks(this.#database, {
        cursor: options.cursor ?? null,
        limit: pageSize + 1,
      })
    ).map(deserializeBetterAuthDurableHook);
    const items = hooks.slice(0, pageSize);
    const hasNextPage = hooks.length > pageSize;
    return {
      configured: true,
      hooksEnabled: true,
      namespace: "better-auth",
      items,
      cursor: hasNextPage ? items.at(-1)?.id : undefined,
      hasNextPage,
    };
  }

  async getDurableHook(hookId: string): Promise<DurableHookQueueEntry | null> {
    const hook = await getBetterAuthDurableHook(this.#database, hookId);
    return hook ? deserializeBetterAuthDurableHook(hook) : null;
  }

  async wakeDurableHooks() {
    // Better Auth hooks run in this object's own alarm, not a Fragno dispatcher.
    await this.#state.storage.setAlarm(Date.now());
  }

  async #authContext(baseURL = "http://localhost") {
    await this.#ready;
    return await getAuthContext(this.#getAuth(baseURL));
  }

  async verifyUserEmail(input: VerifyUserEmailInput): Promise<VerifyUserEmailResult> {
    const { adapter, internalAdapter } = await this.#authContext();
    const user = await findStoreUser(adapter, input.userId);
    if (!user) {
      return { ok: false, code: "user_not_found" };
    }
    if (
      input.expectedEmail &&
      user.email.toLowerCase() !== input.expectedEmail.trim().toLowerCase()
    ) {
      return { ok: false, code: "email_changed" };
    }
    if (normalizeBoolean(user.emailVerified)) {
      return { ok: true, status: "already_verified", emailVerifiedAt: input.verifiedAt };
    }
    await internalAdapter.updateUser(input.userId, {
      emailVerified: true,
      updatedAt: input.verifiedAt,
    });
    return { ok: true, status: "verified", emailVerifiedAt: input.verifiedAt };
  }

  async getBackofficeMe(input: {
    userId: string;
    activeOrganizationId: string | null;
  }): Promise<BackofficeMeData | null> {
    const { adapter } = await this.#authContext();
    return await buildBackofficeMe(adapter, this.#database, input);
  }

  /** Creates Auth-owned credentials; the caller identity comes from the authorized runtime tool. */
  async createAdminOAuthClient({
    administratorUserId,
    ...input
  }: BackofficeOAuthClientCreateRequest & {
    administratorUserId: string;
  }): Promise<BackofficeOAuthClientCreateResult> {
    const parsed = {
      ...backofficeOAuthClientCreateInputSchema.parse(input),
      administratorUserId: z.string().min(1).parse(administratorUserId),
    };
    await this.#ready;
    // Endpoint session injection is confined to this instance, never the cached HTTP Auth instances.
    const auth = betterAuth(this.#createOptions("http://localhost"));
    return await createBackofficeAdminOAuthClient(auth, parsed);
  }

  /** Global catalog access checks live administrator authority before reading Auth client metadata. */
  async listAdminOAuthClients(
    input: BackofficeOAuthClientListInput & { administratorUserId: string },
  ): Promise<BackofficeOAuthClientPage> {
    const parsed = backofficeOAuthClientListInputSchema
      .extend({ administratorUserId: z.string().min(1) })
      .parse(input);
    await this.#ready;
    if (!(await this.#isUserAdministrator(parsed.administratorUserId))) {
      throw new Error("Admin OAuth client listing requires an active administrator user.");
    }
    return await listBackofficeOAuthClients(this.#getAuth("http://localhost"), parsed);
  }

  /** Owner-only client changes run on an isolated Auth instance under live administrator checks. */
  async updateAdminOAuthClient({
    administratorUserId,
    ...input
  }: BackofficeOAuthClientUpdateInput & {
    administratorUserId: string;
  }): Promise<BackofficeOAuthClientUpdateResult> {
    const parsed = {
      ...backofficeOAuthClientUpdateInputSchema.parse(input),
      administratorUserId: z.string().min(1).parse(administratorUserId),
    };
    await this.#ready;
    return await updateBackofficeAdminOAuthClient(
      betterAuth(this.#createOptions("http://localhost")),
      parsed,
    );
  }

  async rotateAdminOAuthClientSecret(
    input: BackofficeOAuthClientRotateSecretInput & { administratorUserId: string },
  ): Promise<BackofficeOAuthClientRotateSecretResult> {
    const parsed = backofficeOAuthClientRotateSecretInputSchema
      .extend({ administratorUserId: z.string().min(1) })
      .parse(input);
    await this.#ready;
    return await rotateBackofficeAdminOAuthClientSecret(
      betterAuth(this.#createOptions("http://localhost")),
      parsed,
    );
  }

  /** Internal client lookup for app registration and installation; never exposes credentials. */
  async getOAuthClientFacts(input: {
    clientId: string;
  }): Promise<BackofficeOAuthClientFacts | null> {
    const clientId = z.string().min(1).max(191).parse(input.clientId);
    await this.#ready;
    return await getBackofficeOAuthClientFacts(this.#getAuth("http://localhost"), clientId);
  }

  /** Signs a short-lived code the app's server redeems to claim the installation it was sent for. */
  async issueAppInstallationCode(input: {
    appId: string;
    owner: AppInstallationOwner;
    activation: number;
  }): Promise<{ code: string }> {
    const parsed = z
      .strictObject({
        appId: z.string().min(1),
        owner: backofficeRootOwnerSchema,
        activation: z.number().int().positive(),
      })
      .parse(input);
    const authContext = await this.#authContext();
    const issued = await issueAppInstallationCode(
      { context: authContext } as Parameters<typeof issueAppInstallationCode>[0],
      parsed,
    );
    return { code: issued.token };
  }

  /** Callers are the installation objects, which resolve every claim from installation state. */
  async issueAppActionToken(input: AppActionTokenInput): Promise<{ token: string }> {
    const authContext = await this.#authContext();
    const issued = await issueAppActionToken(
      { context: authContext } as Parameters<typeof issueAppActionToken>[0],
      input,
    );
    return { token: issued.token };
  }

  async getBackofficeCliOAuthConfig(input: {
    requestUrl: string;
  }): Promise<BackofficeCliOAuthConfig> {
    await this.#ready;
    const baseURL = new URL(input.requestUrl).origin;
    return await getBackofficeCliOAuthConfig(this.#getAuth(baseURL), input);
  }

  #resolveOAuthClientPolicy(auth: BetterAuthInstance, requestUrl: string) {
    const objects = this.#runtime.objects;
    return async function resolveOAuthClientPolicy(clientId: string) {
      return await resolveBackofficeOAuthExecutionPolicy(auth, {
        requestUrl,
        clientId,
        findAppIdByOAuthClientId: async function findRegisteredAppId(oauthClientId) {
          const app = await objects.apps.singleton().commands.getAppByOAuthClientId({
            oauthClientId,
          });
          return app?.id ?? null;
        },
      });
    };
  }

  async authenticateInstalledAppClient(input: {
    requestUrl: string;
    oauthAccessToken: string;
  }): Promise<{ appId: string }> {
    const parsed = backofficeExecutionTokenExchangeInputSchema
      .pick({ requestUrl: true, oauthAccessToken: true })
      .parse(input);
    await this.#ready;
    const auth = this.#getAuth(new URL(parsed.requestUrl).origin);
    return await authenticateInstalledAppClient(auth, parsed, {
      resolveClientPolicy: this.#resolveOAuthClientPolicy(auth, parsed.requestUrl),
    });
  }

  async exchangeBackofficeExecutionToken(
    input: BackofficeExecutionTokenExchangeInput,
  ): Promise<BackofficeExecutionTokenResult> {
    const parsed = backofficeExecutionTokenExchangeInputSchema.parse(input);
    await this.#ready;
    const auth = this.#getAuth(new URL(parsed.requestUrl).origin);
    const objects = this.#runtime.objects;
    return await exchangeBackofficeExecutionToken(auth, parsed, {
      resolveClientPolicy: this.#resolveOAuthClientPolicy(auth, parsed.requestUrl),
      resolveUserGrant: async (adapter, input) =>
        await resolveBackofficeUserTokenGrant(adapter, this.#database, input),
      resolveActiveInstallation: async function resolveActiveInstallation(input) {
        const installation = await objects.appInstallations
          .for(input.owner)
          .commands.getInstallation({ appId: input.appId });
        return installation?.status === "active"
          ? {
              activation: installation.activation,
              resourceScope: installation.resourceScope,
              externalAccount: installation.externalAccount,
            }
          : null;
      },
    });
  }

  async #handleAdminGrantRequest(request: Request): Promise<Response> {
    const configuredToken = this.#env.AUTH_ADMIN_GRANT_TOKEN?.trim();
    if (!configuredToken) {
      return Response.json({ error: "Admin granting is not configured." }, { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }

    const authorization = request.headers.get("authorization");
    const providedToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!providedToken || !(await adminGrantTokensMatch(providedToken, configuredToken))) {
      return Response.json({ error: "Admin grant token is invalid." }, { status: 401 });
    }

    const parsedInput = grantBackofficeAdminInputSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsedInput.success) {
      return Response.json({ error: "A valid email address is required." }, { status: 400 });
    }
    if (!parsedInput.data.email.endsWith("@rejot.dev")) {
      return Response.json(
        { error: "Administrator access requires a @rejot.dev email address." },
        { status: 400 },
      );
    }

    return Response.json(await this.grantBackofficeAdminByEmail({ email: parsedInput.data.email }));
  }

  async grantBackofficeAdminByEmail(input: { email: string }): Promise<GrantBackofficeAdminResult> {
    let releaseGrant: () => void = () => undefined;
    const previousGrant = this.#adminGrantQueue;
    this.#adminGrantQueue = new Promise((resolve) => {
      releaseGrant = resolve;
    });
    await previousGrant;

    try {
      // The first-admin decision spans asynchronous adapter calls, so SQL statement atomicity
      // alone cannot protect it when another Node process also grants administrator access.
      return await this.#state.blockConcurrencyWhile(
        async () => await this.#grantBackofficeAdminByEmail(input),
      );
    } finally {
      releaseGrant();
    }
  }

  async #grantBackofficeAdminByEmail(input: {
    email: string;
  }): Promise<GrantBackofficeAdminResult> {
    const { adapter } = await this.#authContext();
    const email = input.email.trim().toLowerCase();
    const candidateUsers = await this.#database
      .selectFrom("user")
      .selectAll()
      .where((expressionBuilder) =>
        expressionBuilder.or([
          expressionBuilder("email", "=", email),
          expressionBuilder("role", "like", "%admin%"),
        ]),
      )
      .execute();
    const user = candidateUsers.find(
      (candidateUser) => candidateUser.email.trim().toLowerCase() === email,
    );
    if (!user) {
      return { status: "user_not_found" };
    }
    if (normalizeBoolean(user.banned)) {
      return { status: "user_not_active" };
    }
    if (normalizeRole(user.role) === "admin") {
      return { status: "already_admin", userId: user.id };
    }

    const hasExistingAdmin = candidateUsers.some(
      (candidateUser) => normalizeRole(candidateUser.role) === "admin",
    );
    if (hasExistingAdmin && !normalizeBoolean(user.emailVerified)) {
      return { status: "email_not_verified", userId: user.id };
    }

    await adapter.update<StoreUser>({
      model: "user",
      where: [{ field: "id", value: user.id }],
      update: { role: "admin", updatedAt: new Date() },
    });
    return { status: "granted", userId: user.id };
  }

  async createAdminOrganization(input: {
    name: string;
    slug: string;
    ownerEmail: string;
  }): Promise<AdminOrganizationRecord> {
    const { adapter } = await this.#authContext();
    const ownerEmail = input.ownerEmail.trim().toLowerCase();
    const owner = await findStoreUserByEmail(adapter, ownerEmail);
    if (!owner) {
      throw new Error(`Admin organization create could not find user '${ownerEmail}'.`);
    }
    const organization = await getOrganizationAdminEndpoints(
      this.#getAuth("http://localhost"),
    ).createOrganization({
      body: {
        name: input.name,
        slug: input.slug,
        userId: owner.id,
      },
    });
    return {
      organizationId: organization.id,
      name: input.name,
      slug: organization.slug,
      ownerUserId: owner.id,
    };
  }

  /**
   * The slug a new organization with this name gets: its base, numbered after the organizations
   * that share it. Auth handles no other request between this lookup and the insert that follows
   * it, as it awaits only its own database. Outside I/O in between, such as an organization hook
   * calling another object, would let a concurrent creation take the slug first, and the unique
   * slug would reject this one.
   */
  async #nextOrganizationSlug(name: string): Promise<string> {
    const { adapter } = await this.#authContext();
    const base = organizationSlugFromName(name);
    const sharing = await adapter.findMany<StoreOrganization>({
      model: "organization",
      where: [{ field: "slug", operator: "starts_with", value: base }],
    });
    return nextNumberedSlug(
      base,
      sharing.map(({ slug }) => slug),
    );
  }

  /**
   * Creates an organization the user owns, numbering its slug after those its name shares. It keeps
   * its objects where the user's own are kept. Creating it again with the same ID, as a retried
   * workflow step does, returns the organization the first attempt created.
   */
  async createUserOrganization(input: {
    id: string;
    userId: string;
    name: string;
  }): Promise<{ id: string; slug: string }> {
    const { adapter } = await this.#authContext();
    const user = await findStoreUser(adapter, input.userId);
    if (!user) {
      throw new Error(`Organization creation could not find user '${input.userId}'.`);
    }
    return await this.#createOwnedOrganization({
      ...input,
      jurisdiction: user.jurisdiction,
      managingOrganizationId: null,
    });
  }

  /**
   * Creates a client organization of an organization the user owns or administers, which manages
   * it. The client keeps its objects where the managing organization's are, and its creator owns
   * it, as every organization has an owner. Creating it again with the same ID returns it.
   */
  async createManagedOrganization(input: {
    id: string;
    userId: string;
    managingOrganizationId: string;
    name: string;
  }): Promise<{ id: string; slug: string }> {
    const { adapter } = await this.#authContext();
    const [managing, membership] = await Promise.all([
      adapter.findOne<StoreOrganization>({
        model: "organization",
        where: [{ field: "id", value: input.managingOrganizationId }],
      }),
      adapter.findOne<StoreMember>({
        model: "member",
        where: [
          { field: "organizationId", value: input.managingOrganizationId },
          { field: "userId", value: input.userId },
        ],
      }),
    ]);
    if (!managing || !membership || !administersMembers(splitOrganizationRoles(membership.role))) {
      throw new Error(
        `User '${input.userId}' does not own or administer organization '${input.managingOrganizationId}'.`,
      );
    }
    return await this.#createOwnedOrganization({
      id: input.id,
      userId: input.userId,
      name: input.name,
      jurisdiction: managing.jurisdiction,
      managingOrganizationId: managing.id,
    });
  }

  /**
   * Creates an organization with its creator as owner, or returns the one this ID already names.
   * Its database triggers queue the same hooks Better Auth's creation does.
   */
  async #createOwnedOrganization(input: {
    id: string;
    userId: string;
    name: string;
    jurisdiction: BackofficeJurisdiction | null;
    managingOrganizationId: string | null;
  }): Promise<{ id: string; slug: string }> {
    const { adapter } = await this.#authContext();
    const slug = await this.#nextOrganizationSlug(input.name);
    return await adapter.transaction(async (transaction) => {
      const existing = await transaction.findOne<StoreOrganization>({
        model: "organization",
        where: [{ field: "id", value: input.id }],
      });
      if (existing) {
        if (existing.createdBy !== input.userId) {
          throw new Error(`Organization '${input.id}' was created by another user.`);
        }
        return { id: existing.id, slug: existing.slug };
      }
      const now = new Date();
      await transaction.create({
        model: "organization",
        data: {
          id: input.id,
          name: input.name,
          slug,
          logo: null,
          metadata: null,
          createdBy: input.userId,
          createdAt: now,
          updatedAt: now,
          managingOrganizationId: input.managingOrganizationId,
          jurisdiction: input.jurisdiction,
        },
        forceAllowId: true,
      });
      await transaction.create({
        model: "member",
        data: {
          organizationId: input.id,
          userId: input.userId,
          role: BACKOFFICE_ORGANIZATION_OWNER_ROLE,
          createdAt: now,
        },
      });
      return { id: input.id, slug };
    });
  }

  /**
   * Fixes where the user's personal scope will keep its objects, and the organizations they create
   * theirs. Onboarding chooses it before creating anything; once onboarding has finished and the
   * personal scope exists, it cannot change.
   */
  async chooseUserJurisdiction(input: {
    userId: string;
    jurisdiction: BackofficeJurisdiction | null;
  }): Promise<void> {
    const { adapter } = await this.#authContext();
    await adapter.transaction(async (transaction) => {
      const user = await transaction.findOne<StoreUser>({
        model: "user",
        where: [{ field: "id", value: input.userId }],
      });
      if (!user) {
        throw new Error(`Onboarding could not find user '${input.userId}'.`);
      }
      if (user.jurisdiction === input.jurisdiction) {
        return;
      }
      if (user.onboardedAt !== null) {
        throw new Error(
          `User '${input.userId}' has finished onboarding, fixing their jurisdiction.`,
        );
      }
      await transaction.update<StoreUser>({
        model: "user",
        where: [{ field: "id", value: input.userId }],
        update: { jurisdiction: input.jurisdiction, updatedAt: new Date() },
      });
    });
  }

  /**
   * Ends the user's onboarding, which creates their personal scope in the jurisdiction they chose.
   * Finishing it again changes nothing.
   */
  async finishUserOnboarding(input: { userId: string }): Promise<void> {
    const { adapter } = await this.#authContext();
    await adapter.transaction(async (transaction) => {
      const user = await transaction.findOne<StoreUser>({
        model: "user",
        where: [{ field: "id", value: input.userId }],
      });
      if (!user) {
        throw new Error(`Onboarding could not find user '${input.userId}'.`);
      }
      if (user.onboardedAt !== null) {
        return;
      }
      const now = new Date();
      await transaction.update<StoreUser>({
        model: "user",
        where: [{ field: "id", value: input.userId }],
        update: { onboardedAt: now, updatedAt: now },
      });
    });
  }

  /**
   * Whether the user authorized the app's OAuth client. Provisioning reaches only these users, never
   * other Backoffice users.
   */
  async #hasAuthorizedApp(oauthClientId: string, userId: string): Promise<boolean> {
    const { adapter } = await this.#authContext();
    const consent = await adapter.findOne<{ id: string }>({
      model: "oauthConsent",
      select: ["id"],
      where: [
        { field: "clientId", value: oauthClientId },
        { field: "userId", value: userId },
      ],
    });
    return consent !== null;
  }

  /**
   * How a user who authorized the app acts in the organization: as one of its members, or through
   * the organization managing it. Provisioning acts for no one else.
   */
  async confirmAppOrganizationActor(input: {
    oauthClientId: string;
    organizationId: string;
    userId: string;
  }): Promise<AppProvisioningResult<OrganizationAccess>> {
    await this.#ready;
    const [access, authorized] = await Promise.all([
      findOrganizationAccess(this.#database, {
        userId: input.userId,
        organizationId: input.organizationId,
      }),
      this.#hasAuthorizedApp(input.oauthClientId, input.userId),
    ]);
    if (!access || !authorized) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: `User '${input.userId}' does not act in the organization, as a member of it or of the organization managing it, or has not authorized this app.`,
        },
      };
    }
    return { ok: true, value: access };
  }

  async #findAppOrganizationRecord(input: {
    appId: string;
    externalOrganizationId: string;
  }): Promise<StoreOrganization | null> {
    const { adapter } = await this.#authContext();
    return await adapter.findOne<StoreOrganization>({
      model: "organization",
      where: [
        {
          field: "id",
          value: provisionedResourceId({
            appId: input.appId,
            kind: "organization",
            externalId: input.externalOrganizationId,
          }),
        },
      ],
    });
  }

  /**
   * Creates an organization owned by a user linked to the app. Its ID is derived from the app's
   * organization, so a repeated call finds it. Better Auth's endpoint chooses IDs itself, so the
   * organization and its owner are written here, in one transaction.
   */
  async provisionAppOrganization(
    input: ProvisioningApp & ProvisionOrganizationInput,
  ): Promise<AppProvisioningResult<ProvisionOrganizationResult>> {
    const { appId, oauthClientId, ...organization } = input;
    const parsed = provisionOrganizationInputSchema.parse(organization);
    const existing = await this.#findAppOrganizationRecord({
      appId,
      externalOrganizationId: parsed.externalOrganizationId,
    });
    if (existing) {
      return {
        ok: true,
        value: {
          organizationId: existing.id,
          slug: existing.slug,
          jurisdiction: existing.jurisdiction,
          created: false,
        },
      };
    }
    if (!(await this.#hasAuthorizedApp(oauthClientId, parsed.ownerUserId))) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: `User '${parsed.ownerUserId}' has not authorized this app.`,
        },
      };
    }
    const organizationId = provisionedResourceId({
      appId,
      kind: "organization",
      externalId: parsed.externalOrganizationId,
    });
    const slug = await this.#nextOrganizationSlug(parsed.name);
    const { adapter } = await this.#authContext();
    await adapter.transaction(async (transaction) => {
      const now = new Date();
      await transaction.create({
        model: "organization",
        data: {
          id: organizationId,
          name: parsed.name,
          slug,
          createdBy: parsed.ownerUserId,
          createdAt: now,
        },
        forceAllowId: true,
      });
      await transaction.create({
        model: "member",
        data: {
          organizationId,
          userId: parsed.ownerUserId,
          role: BACKOFFICE_ORGANIZATION_OWNER_ROLE,
          createdAt: now,
        },
      });
    });
    // Apps provision organizations without choosing where their objects are kept.
    return { ok: true, value: { organizationId, slug, jurisdiction: null, created: true } };
  }

  /**
   * Creates an organization for an owner who may not have a Backoffice account yet: no members, and
   * a pending owner invitation from a user who authorized the app, who does not become a member.
   * Its ID is derived from the app's organization, so a repeated call finds it and returns its
   * pending owner invitation, a new one once that expired, or none once it has an owner. Better
   * Auth's invitation endpoint only lets members invite, so the rows are written here.
   */
  async provisionAppOrganizationForInvitee(
    input: ProvisioningApp & ProvisionOrganizationForInviteeInput,
  ): Promise<AppProvisioningResult<ProvisionOrganizationForInviteeResult>> {
    const { appId, oauthClientId, ...organization } = input;
    const parsed = provisionOrganizationForInviteeInputSchema.parse(organization);
    if (!(await this.#hasAuthorizedApp(oauthClientId, parsed.invitedByUserId))) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: `User '${parsed.invitedByUserId}' has not authorized this app.`,
        },
      };
    }
    const organizationId = provisionedResourceId({
      appId,
      kind: "organization",
      externalId: parsed.externalOrganizationId,
    });
    const { adapter } = await this.#authContext();
    const existing = await this.#findAppOrganizationRecord({
      appId,
      externalOrganizationId: parsed.externalOrganizationId,
    });
    const slug = existing?.slug ?? (await this.#nextOrganizationSlug(parsed.name));
    const ownerInvitation = await adapter.transaction(async (transaction) => {
      const now = new Date();
      if (!existing) {
        await transaction.create({
          model: "organization",
          data: {
            id: organizationId,
            name: parsed.name,
            slug,
            createdBy: parsed.invitedByUserId,
            createdAt: now,
          },
          forceAllowId: true,
        });
      }
      return await ensureOwnerInvitation(transaction, {
        organizationId,
        email: parsed.ownerEmail,
        inviterId: parsed.invitedByUserId,
        now,
      });
    });
    if (ownerInvitation === "invited-someone-else") {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "The organization's owner invitation is pending for another address.",
        },
      };
    }
    return {
      ok: true,
      value: {
        organizationId,
        slug,
        jurisdiction: existing?.jurisdiction ?? null,
        created: !existing,
        ownerInvitation: ownerInvitation && {
          invitationId: ownerInvitation.id,
          expiresAt: toIsoString(toDate(ownerInvitation.expiresAt)),
        },
      },
    };
  }

  /**
   * Creates an organization managed by another, for an invited owner or none: no members, and the
   * managing organization's owner or admin who asked recorded as its creator and its owner's
   * inviter. It keeps its objects where the managing organization's are. Its ID is derived from the
   * app's organization, so a repeated call finds it, as for an invitee.
   */
  async provisionAppManagedOrganization(
    input: ProvisioningApp & ProvisionManagedOrganizationInput,
  ): Promise<AppProvisioningResult<ProvisionManagedOrganizationResult>> {
    const { appId, oauthClientId, ...organization } = input;
    const parsed = provisionManagedOrganizationInputSchema.parse(organization);
    if (!(await this.#hasAuthorizedApp(oauthClientId, parsed.byUserId))) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: `User '${parsed.byUserId}' has not authorized this app.`,
        },
      };
    }
    const { adapter } = await this.#authContext();
    const [managing, membership, existing] = await Promise.all([
      adapter.findOne<StoreOrganization>({
        model: "organization",
        where: [{ field: "id", value: parsed.managingOrganizationId }],
      }),
      adapter.findOne<StoreMember>({
        model: "member",
        where: [
          { field: "organizationId", value: parsed.managingOrganizationId },
          { field: "userId", value: parsed.byUserId },
        ],
      }),
      this.#findAppOrganizationRecord({
        appId,
        externalOrganizationId: parsed.externalOrganizationId,
      }),
    ]);
    if (!managing) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Organization '${parsed.managingOrganizationId}' does not exist.`,
        },
      };
    }
    // Its own owners and admins, since management reaches one organization deep.
    if (!membership || !administersMembers(splitOrganizationRoles(membership.role))) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: `User '${parsed.byUserId}' does not own or administer organization '${managing.id}'.`,
        },
      };
    }
    if (existing && existing.managingOrganizationId !== managing.id) {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: `The app's organization '${parsed.externalOrganizationId}' exists, managed by another organization or by none.`,
        },
      };
    }
    const organizationId = provisionedResourceId({
      appId,
      kind: "organization",
      externalId: parsed.externalOrganizationId,
    });
    const slug = existing?.slug ?? (await this.#nextOrganizationSlug(parsed.name));
    const ownerInvitation = await adapter.transaction(async (transaction) => {
      const now = new Date();
      if (!existing) {
        await transaction.create({
          model: "organization",
          data: {
            id: organizationId,
            name: parsed.name,
            slug,
            createdBy: parsed.byUserId,
            createdAt: now,
            managingOrganizationId: managing.id,
            jurisdiction: managing.jurisdiction,
          },
          forceAllowId: true,
        });
      }
      return parsed.owner.kind === "invitee"
        ? await ensureOwnerInvitation(transaction, {
            organizationId,
            email: parsed.owner.email,
            inviterId: parsed.byUserId,
            now,
          })
        : null;
    });
    if (ownerInvitation === "invited-someone-else") {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "The organization's owner invitation is pending for another address.",
        },
      };
    }
    return {
      ok: true,
      value: {
        organizationId,
        slug,
        // Its objects stay where it was made, even if it was moved under another manager since.
        jurisdiction: existing ? existing.jurisdiction : managing.jurisdiction,
        created: !existing,
        ownerInvitation: ownerInvitation && {
          invitationId: ownerInvitation.id,
          expiresAt: toIsoString(toDate(ownerInvitation.expiresAt)),
        },
      },
    };
  }

  /**
   * A page of the organizations an organization manages, by ID. The provisioning route keeps those
   * where the calling app is installed.
   */
  async listManagedOrganizations(
    input: ListManagedOrganizationsInput,
  ): Promise<Omit<ManagedOrganizationPage, "hasNextPage">> {
    const { adapter } = await this.#authContext();
    const { managingOrganizationId, ...page } = input;
    return await readManagedOrganizationPage(adapter, { managingOrganizationId, page });
  }

  /** The organization an invitation is to, in any status; the app's installation there decides. */
  async findInvitation(input: { invitationId: string }): Promise<AppInvitation | null> {
    const { adapter } = await this.#authContext();
    const invitation = await adapter.findOne<StoreInvitation>({
      model: "invitation",
      where: [{ field: "id", value: input.invitationId }],
    });
    if (!invitation) {
      return null;
    }
    const [organization, inviter] = await Promise.all([
      adapter.findOne<StoreOrganization>({
        model: "organization",
        where: [{ field: "id", value: invitation.organizationId }],
      }),
      findStoreUser(adapter, invitation.inviterId),
    ]);
    if (!organization || !inviter) {
      throw new Error(`Invitation '${invitation.id}' names a missing organization or inviter.`);
    }
    const expiresAt = toDate(invitation.expiresAt);
    return {
      organizationId: organization.id,
      organizationName: organization.name,
      email: invitation.email,
      inviterName: inviter.name || inviter.email,
      pending: invitation.status === "pending" && expiresAt > new Date(),
      expiresAt: toIsoString(expiresAt),
    };
  }

  /**
   * Accepts an invitation for a user who authorized the app, as Better Auth would for them. The
   * user's own verified address must be the one invited. An invitation the user already accepted
   * returns their membership, so the app can retry.
   */
  async acceptAppInvitation(
    input: Pick<ProvisioningApp, "oauthClientId"> & AcceptInvitationInput,
  ): Promise<AppProvisioningResult<OrganizationMembershipRecord>> {
    const { oauthClientId, ...accept } = input;
    const parsed = acceptInvitationInputSchema.parse(accept);
    if (!(await this.#hasAuthorizedApp(oauthClientId, parsed.userId))) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: `User '${parsed.userId}' has not authorized this app.`,
        },
      };
    }
    const { adapter } = await this.#authContext();
    const invitation = await adapter.findOne<StoreInvitation>({
      model: "invitation",
      where: [{ field: "id", value: parsed.invitationId }],
    });
    const user = await findStoreUser(adapter, parsed.userId);
    if (!invitation || !user) {
      throw new Error(`Invitation '${parsed.invitationId}' or user '${parsed.userId}' is gone.`);
    }
    if (
      invitation.email.toLowerCase() !== user.email.toLowerCase() ||
      !normalizeBoolean(user.emailVerified)
    ) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: "The invitation is not addressed to this user's verified email.",
        },
      };
    }
    if (invitation.status === "accepted") {
      const membership = await readOrganizationMembership(adapter, {
        organizationId: invitation.organizationId,
        userId: user.id,
      });
      if (membership) {
        return { ok: true, value: membership };
      }
    }
    if (invitation.status !== "pending" || new Date(invitation.expiresAt) < new Date()) {
      return {
        ok: false,
        error: { code: "conflict", message: "The invitation is no longer pending." },
      };
    }
    return {
      ok: true,
      value: await this.acceptAccountInvitation({
        userId: user.id,
        invitationId: invitation.id,
      }),
    };
  }

  /**
   * Invites as a member who authorized the app, so Better Auth applies the inviter's live role
   * exactly as when they invite in Backoffice. Inviting an address again returns its pending
   * invitation when the roles match, so the app can retry.
   */
  async createAppInvitation(
    input: Pick<ProvisioningApp, "oauthClientId"> & CreateInvitationInput,
  ): Promise<AppProvisioningResult<OrganizationInvitationRecord>> {
    const { oauthClientId, ...invite } = input;
    const parsed = createInvitationInputSchema.parse(invite);
    const inviter = await this.confirmAppOrganizationActor({
      oauthClientId,
      organizationId: parsed.organizationId,
      userId: parsed.inviterUserId,
    });
    if (!inviter.ok) {
      return inviter;
    }
    if (inviter.value.through.kind === "managing-organization") {
      return await this.#inviteThroughManagingOrganization(parsed, inviter.value.roles);
    }
    try {
      return { ok: true, value: await this.createOrganizationInvitation(parsed) };
    } catch (error) {
      if (!(error instanceof APIError)) {
        throw error;
      }
      // Better Auth refuses with FORBIDDEN when the inviter's role does not allow the invitation.
      if (error.status === "FORBIDDEN") {
        return { ok: false, error: { code: "forbidden", message: error.message } };
      }
      if (error.body?.code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION") {
        return { ok: false, error: { code: "conflict", message: error.message } };
      }
      // Better Auth checks the inviter's role before refusing a second invitation.
      if (error.body?.code === "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION") {
        return await this.#reusePendingInvitation(parsed);
      }
      throw error;
    }
  }

  /**
   * Invites as someone acting through the organization managing it. Better Auth's organization
   * endpoints serve only members, so its rules are applied here: owners and admins invite, and only
   * owners invite owners. Management never confers owner, so they invite one only while the
   * organization has none.
   */
  async #inviteThroughManagingOrganization(
    input: CreateInvitationInput,
    roles: string[],
  ): Promise<AppProvisioningResult<OrganizationInvitationRecord>> {
    if (!administersMembers(roles)) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only owners and admins invite." },
      };
    }
    const { adapter } = await this.#authContext();
    return await adapter.transaction(
      async (transaction): Promise<AppProvisioningResult<OrganizationInvitationRecord>> => {
        const now = new Date();
        const pendingWhere = [
          { field: "organizationId", value: input.organizationId },
          { field: "status", value: "pending" },
          { field: "expiresAt", operator: "gt" as const, value: now },
        ];
        const [invitee, pending] = await Promise.all([
          transaction.findOne<StoreUser>({
            model: "user",
            where: [{ field: "email", value: input.email }],
          }),
          transaction.findOne<StoreInvitation>({
            model: "invitation",
            where: [...pendingWhere, { field: "email", value: input.email }],
          }),
        ]);
        if (
          input.roles.includes(BACKOFFICE_ORGANIZATION_OWNER_ROLE) &&
          (await organizationHasOwner(transaction, input.organizationId))
        ) {
          return {
            ok: false,
            error: {
              code: "forbidden",
              message:
                "Only the organization's own owners invite owners, once it has one: its managing organization invites one only while it has none.",
            },
          };
        }
        const member =
          invitee &&
          (await transaction.findOne<{ id: string }>({
            model: "member",
            select: ["id"],
            where: [
              { field: "organizationId", value: input.organizationId },
              { field: "userId", value: invitee.id },
            ],
          }));
        if (member) {
          return {
            ok: false,
            error: {
              code: "conflict",
              message: `'${input.email}' is already a member of this organization.`,
            },
          };
        }
        if (pending) {
          return samePendingInvitation(pending, input);
        }
        if (
          (await transaction.count({ model: "invitation", where: pendingWhere })) >=
          PENDING_INVITATION_LIMIT
        ) {
          return {
            ok: false,
            error: {
              code: "forbidden",
              message: `The organization has ${PENDING_INVITATION_LIMIT} pending invitations, the most it may have.`,
            },
          };
        }
        const created = await transaction.create<StoreInvitation>({
          model: "invitation",
          data: {
            organizationId: input.organizationId,
            email: input.email,
            role: input.roles.join(","),
            status: "pending",
            inviterId: input.inviterUserId,
            expiresAt: new Date(now.getTime() + APP_INVITATION_LIFETIME_MS),
            createdAt: now,
          },
        });
        return { ok: true, value: toOrganizationInvitationRecord(created) };
      },
    );
  }

  /** The address's pending invitation, when it is for the same roles. */
  async #reusePendingInvitation(
    input: Pick<CreateInvitationInput, "organizationId" | "email" | "roles">,
  ): Promise<AppProvisioningResult<OrganizationInvitationRecord>> {
    const { adapter } = await this.#authContext();
    const pending = await adapter.findOne<StoreInvitation>({
      model: "invitation",
      where: [
        { field: "organizationId", value: input.organizationId },
        { field: "email", value: input.email },
        { field: "status", value: "pending" },
        { field: "expiresAt", operator: "gt", value: new Date() },
      ],
    });
    if (!pending) {
      throw new Error(
        `Auth refused to invite '${input.email}' again but has no pending invitation.`,
      );
    }
    return samePendingInvitation(pending, input);
  }

  async verifyAdminUserEmail(input: { email: string }): Promise<AdminUserEmailVerificationRecord> {
    const { adapter } = await this.#authContext();
    const email = input.email.trim().toLowerCase();
    const user = await findStoreUserByEmail(adapter, email);
    if (!user) {
      throw new Error(`Admin email verification could not find user '${email}'.`);
    }
    const verification = await this.verifyUserEmail({
      userId: user.id,
      expectedEmail: email,
      verifiedAt: new Date(),
    });
    if (!verification.ok) {
      throw new Error(`Admin email verification failed for '${email}': ${verification.code}.`);
    }
    return { userId: user.id, email, status: verification.status };
  }

  async addAdminOrganizationMember(input: {
    organizationId: string;
    userEmail: string;
    roles: readonly OrganizationRole[];
  }): Promise<AdminOrganizationMemberRecord> {
    const roles = organizationRoleSchema.array().min(1).parse(input.roles);
    const { adapter } = await this.#authContext();
    const userEmail = input.userEmail.trim().toLowerCase();
    const user = await findStoreUserByEmail(adapter, userEmail);
    if (!user) {
      throw new Error(`Admin organization member add could not find user email '${userEmail}'.`);
    }
    const member = await getOrganizationAdminEndpoints(this.#getAuth("http://localhost")).addMember(
      {
        body: {
          organizationId: input.organizationId,
          userId: user.id,
          role: roles,
        },
      },
    );
    return {
      organizationId: member.organizationId,
      userId: member.userId,
      roles: splitOrganizationRoles(member.role),
    };
  }

  async removeAdminOrganizationMember(input: {
    organizationId: string;
    userEmail: string;
  }): Promise<AdminOrganizationMemberRecord> {
    const { adapter } = await this.#authContext();
    const userEmail = input.userEmail.trim().toLowerCase();
    const user = await findStoreUserByEmail(adapter, userEmail);
    if (!user) {
      throw new Error(`Admin organization member remove could not find user email '${userEmail}'.`);
    }
    const member = await adapter.findOne<StoreMember>({
      model: "member",
      where: [
        { field: "organizationId", value: input.organizationId },
        { field: "userId", value: user.id },
      ],
    });
    if (!member) {
      throw new Error(
        `Admin organization member remove could not find user email '${userEmail}' in organization '${input.organizationId}'.`,
      );
    }
    const memberRoles = splitOrganizationRoles(member.role);
    if (memberRoles.includes(BACKOFFICE_ORGANIZATION_OWNER_ROLE)) {
      const organizationMembers = await adapter.findMany<StoreMember>({
        model: "member",
        where: [{ field: "organizationId", value: input.organizationId }],
      });
      const ownerCount = organizationMembers.filter((organizationMember) =>
        splitOrganizationRoles(organizationMember.role).includes(
          BACKOFFICE_ORGANIZATION_OWNER_ROLE,
        ),
      ).length;
      if (ownerCount <= 1) {
        throw new Error(
          `Admin organization member remove cannot remove the last owner from organization '${input.organizationId}'.`,
        );
      }
    }
    await adapter.delete({
      model: "member",
      where: [{ field: "id", value: member.id }],
    });
    return {
      organizationId: input.organizationId,
      userId: user.id,
      roles: memberRoles,
    };
  }

  /** Isolated Auth instance keeps the synthetic user session away from HTTP request handling. */
  async #callOrganizationEndpointsAsUser<T>(
    userId: string,
    call: (endpoints: OrganizationUserEndpoints) => Promise<T>,
  ): Promise<T> {
    await this.#ready;
    const auth = betterAuth(this.#createOptions("http://localhost"));
    const authContext = await getAuthContext(auth);
    const user = await authContext.internalAdapter.findUserById(userId);
    if (!user) {
      throw new Error(`Auth could not find user '${userId}'.`);
    }
    const now = new Date();
    authContext.session = {
      user,
      session: {
        id: "backoffice-runtime-organization-command",
        token: "backoffice-runtime-organization-command",
        userId: user.id,
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
        ipAddress: null,
        userAgent: null,
      },
    };
    try {
      return await call(getOrganizationUserEndpoints(auth));
    } finally {
      authContext.session = null;
    }
  }

  async getAccountProfile(input: { userId: string }): Promise<AccountProfile> {
    const { adapter } = await this.#authContext();
    const profile = await readAccountProfile(adapter, input.userId);
    if (!profile) {
      throw new Error(`Account profile could not find user '${input.userId}'.`);
    }
    return profile;
  }

  async updateAccountProfile(input: { userId: string; name: string }): Promise<AccountProfile> {
    const { internalAdapter } = await this.#authContext();
    await internalAdapter.updateUser(input.userId, { name: input.name, updatedAt: new Date() });
    return await this.getAccountProfile({ userId: input.userId });
  }

  async listAccountOrganizations(input: {
    userId: string;
  }): Promise<OrganizationMembershipRecord[]> {
    await this.#ready;
    return (await listAccessibleOrganizations(this.#database, input.userId)).map(
      ({ organization, roles }) => ({
        organization: {
          organizationId: organization.id,
          name: organization.name,
          slug: organization.slug,
          jurisdiction: organization.jurisdiction,
          createdAt: toDate(organization.createdAt).toISOString(),
        },
        roles,
      }),
    );
  }

  async listAccountInvitations(input: { userId: string }): Promise<AccountInvitationListing> {
    const { adapter } = await this.#authContext();
    const user = await findStoreUser(adapter, input.userId);
    if (!user) {
      throw new Error(`Account invitations could not find user '${input.userId}'.`);
    }
    // As Better Auth does: an unproven address must not reveal invitations sent to it.
    if (!normalizeBoolean(user.emailVerified)) {
      return { status: "email-unverified" };
    }
    return {
      status: "listed",
      invitations: await readAccountInvitations(adapter, { email: user.email, now: new Date() }),
    };
  }

  async acceptAccountInvitation(input: {
    userId: string;
    invitationId: string;
  }): Promise<OrganizationMembershipRecord> {
    const { member } = await this.#callOrganizationEndpointsAsUser(
      input.userId,
      async (endpoints) =>
        await endpoints.acceptInvitation({
          headers: new Headers(),
          body: { invitationId: input.invitationId },
        }),
    );
    const membership = await this.getOrganizationMembership({
      organizationId: member.organizationId,
      userId: input.userId,
    });
    if (!membership) {
      throw new Error(`Accepted invitation '${input.invitationId}' produced no membership.`);
    }
    return membership;
  }

  async listAccountOAuthConsents(
    input: { userId: string } & DirectoryPageInput,
  ): Promise<OAuthConsentPage> {
    const { adapter } = await this.#authContext();
    return await listBackofficeOAuthConsentPage(adapter, {
      ...input,
      firstPartyClientIds: await this.#runtime.objects.apps
        .singleton()
        .commands.listFirstPartyOAuthClientIds(),
    });
  }

  async getOrganization(input: { organizationId: string }): Promise<OrganizationRecord | null> {
    const { adapter } = await this.#authContext();
    return await readOrganization(adapter, input.organizationId);
  }

  async getOrganizationMembership(input: {
    organizationId: string;
    userId: string;
  }): Promise<OrganizationMembershipRecord | null> {
    const { adapter } = await this.#authContext();
    const [organization, access] = await Promise.all([
      readOrganization(adapter, input.organizationId),
      findOrganizationAccess(this.#database, input),
    ]);
    return organization && access ? { organization, roles: access.roles } : null;
  }

  /** How the user acts in the organization, as org.get answers it, or null when they do not. */
  async getOrganizationAccess(input: {
    organizationId: string;
    userId: string;
  }): Promise<OrganizationAccessRecord | null> {
    const { adapter } = await this.#authContext();
    const [organization, access, managingOrganization] = await Promise.all([
      readOrganization(adapter, input.organizationId),
      findOrganizationAccess(this.#database, input),
      findManagingOrganization(this.#database, input.organizationId),
    ]);
    return organization && access
      ? { organization, roles: access.roles, managingOrganization, through: access.through.kind }
      : null;
  }

  async updateOrganization(input: {
    organizationId: string;
    name: string;
  }): Promise<OrganizationRecord> {
    const { adapter } = await this.#authContext();
    await adapter.update<StoreOrganization>({
      model: "organization",
      where: [{ field: "id", value: input.organizationId }],
      update: { name: input.name, updatedAt: new Date() },
    });
    const organization = await readOrganization(adapter, input.organizationId);
    if (!organization) {
      throw new Error(`Organization update could not find organization '${input.organizationId}'.`);
    }
    return organization;
  }

  async setOrganizationManager(input: {
    organizationId: string;
    managingOrganizationId: string | null;
  }): Promise<OrganizationManagerRecord> {
    if (input.managingOrganizationId === input.organizationId) {
      throw new Error(`Organization '${input.organizationId}' cannot manage itself.`);
    }
    const { adapter } = await this.#authContext();
    await adapter.update<StoreOrganization>({
      model: "organization",
      where: [{ field: "id", value: input.organizationId }],
      update: { managingOrganizationId: input.managingOrganizationId },
    });
    return {
      organizationId: input.organizationId,
      managingOrganizationId: input.managingOrganizationId,
    };
  }

  async getOrganizationRelations(input: {
    organizationId: string;
  }): Promise<OrganizationRelations> {
    await this.#ready;
    return await readOrganizationRelations(this.#database, input.organizationId);
  }

  async listOrganizations(input: DirectoryPageInput): Promise<OrganizationPage> {
    const { adapter } = await this.#authContext();
    return await readOrganizationPage(adapter, input);
  }

  async listOrganizationMembers({
    organizationId,
    ...page
  }: { organizationId: string } & DirectoryPageInput): Promise<OrganizationMemberPage> {
    const { adapter } = await this.#authContext();
    return await readOrganizationMemberPage(adapter, { organizationId, page });
  }

  async listOrganizationMembersByPage(input: {
    organizationId: string;
    page: number;
    pageSize: number;
  }): Promise<OrganizationMemberNumberedPage> {
    const { adapter } = await this.#authContext();
    return await readOrganizationMemberNumberedPage(adapter, input);
  }

  async listOrganizationInvitations({
    organizationId,
    ...page
  }: { organizationId: string } & DirectoryPageInput): Promise<OrganizationInvitationPage> {
    const { adapter } = await this.#authContext();
    return await readOrganizationInvitationPage(adapter, {
      organizationId,
      now: new Date(),
      page,
    });
  }

  async createOrganizationInvitation(input: {
    organizationId: string;
    inviterUserId: string;
    email: string;
    roles: readonly OrganizationRole[];
  }): Promise<OrganizationInvitationRecord> {
    const roles = organizationRoleSchema.array().min(1).parse(input.roles);
    const invitation = await this.#callOrganizationEndpointsAsUser(
      input.inviterUserId,
      async (endpoints) =>
        await endpoints.createInvitation({
          headers: new Headers(),
          body: { organizationId: input.organizationId, email: input.email, role: roles },
        }),
    );
    return toOrganizationInvitationRecord(invitation);
  }

  async getUserAuthorityFacts(input: {
    userId: string;
    organizationId?: string;
  }): Promise<UserAuthorityFacts> {
    const { adapter } = await this.#authContext();
    const user = await findStoreUser(adapter, input.userId);
    if (!user) {
      return { active: false, role: null, personalScope: null, organization: null };
    }
    const [access, organization] = input.organizationId
      ? await Promise.all([
          findOrganizationAccess(this.#database, {
            userId: input.userId,
            organizationId: input.organizationId,
          }),
          readOrganization(adapter, input.organizationId),
        ])
      : [null, null];
    return {
      active: !normalizeBoolean(user.banned),
      role: normalizeRole(user.role),
      personalScope: backofficePersonalScope(user),
      organization:
        access && organization
          ? {
              kind: "org",
              orgId: organization.organizationId,
              jurisdiction: organization.jurisdiction,
            }
          : null,
    };
  }

  async findAdministeredMember(input: {
    administratorId: string;
    memberId: string;
  }): Promise<AdministeredMember | null> {
    await this.#ready;
    return await findAdministeredMember(this.#database, input);
  }

  async findRootOwnerScope(
    owner: BackofficeRootOwnerReference,
  ): Promise<BackofficeRootOwner<BackofficeScopeIdNames> | null> {
    const { adapter } = await this.#authContext();
    if (owner.kind === "org") {
      const organization = await adapter.findOne<StoreOrganization>({
        model: "organization",
        where: [{ field: "id", value: owner.orgId }],
      });
      return (
        organization && {
          kind: "org",
          orgId: organization.id,
          jurisdiction: organization.jurisdiction,
        }
      );
    }
    const user = await findStoreUser(adapter, owner.userId);
    return user && backofficePersonalScope(user);
  }

  async getUserOrganizationAuthorityFacts(
    input: UserOrganizationAuthorityInput,
  ): Promise<UserOrganizationAuthorityFacts> {
    const { userId, organizationId } = userOrganizationAuthorityInputSchema.parse(input);
    const { adapter } = await this.#authContext();
    const [user, access] = await Promise.all([
      findStoreUser(adapter, userId),
      findOrganizationAccess(this.#database, { userId, organizationId }),
    ]);
    return {
      active: Boolean(user && !normalizeBoolean(user.banned)),
      role: user ? normalizeRole(user.role) : null,
      organizationRoles: access?.roles ?? null,
    };
  }

  async getAllOrganizations(): Promise<Organization[]> {
    const { adapter } = await this.#authContext();
    return (
      await adapter.findMany<StoreOrganization>({
        model: "organization",
        sortBy: { field: "createdAt", direction: "asc" },
      })
    ).map(toOrganization);
  }

  async getOrganizationBySlug(
    slug: string,
  ): Promise<Pick<Organization, "id" | "slug" | "jurisdiction"> | null> {
    const { adapter } = await this.#authContext();
    const organization = await adapter.findOne<StoreOrganization>({
      model: "organization",
      where: [{ field: "slug", value: slug }],
    });
    return organization
      ? { id: organization.id, slug: organization.slug, jurisdiction: organization.jurisdiction }
      : null;
  }

  async hasOrganizationMember(input: { organizationId: string; userId: string }): Promise<boolean> {
    const { adapter } = await this.#authContext();
    return Boolean(
      await adapter.findOne({
        model: "member",
        where: [
          { field: "organizationId", value: input.organizationId },
          { field: "userId", value: input.userId },
        ],
      }),
    );
  }

  async getDevOrganizations() {
    return (await this.getAllOrganizations()).map(
      ({ id, name, slug, createdBy, createdAt, updatedAt }) => ({
        id,
        name,
        slug,
        createdBy,
        createdAt,
        updatedAt,
      }),
    );
  }

  /** Applies deterministic auth fixtures without creating sessions. */
  async applyScenarioFixture(fixture: ScenarioAuthFixture) {
    await Promise.all((fixture.users ?? []).map((user) => this.#setUpScenarioUser(user)));
    await Promise.all(
      (fixture.organizations ?? []).map((organization) =>
        this.#setUpScenarioOrganization(organization),
      ),
    );
    await Promise.all((fixture.members ?? []).map((member) => this.#setUpScenarioMember(member)));
    await Promise.all(
      (fixture.removedMembers ?? []).map((member) => this.#removeScenarioMember(member)),
    );
    await Promise.all(
      (fixture.onboardedEmails ?? []).map((email) => this.#onboardScenarioUser(email)),
    );
    // Scenario fixtures establish starting state; lifecycle behavior is exercised by scenario steps.
    await deleteBetterAuthDurableHooksForFixture(this.#database, {
      userIds: (fixture.users ?? []).map((user) => user.id),
      organizationIds: (fixture.organizations ?? []).map((organization) => organization.id),
    });
  }

  async #setUpScenarioUser(input: {
    id: string;
    email: string;
    role: Role;
    status: "active" | "banned";
  }) {
    const { adapter } = await this.#authContext();
    const existing = await findStoreUser(adapter, input.id);
    const now = new Date();
    const values = {
      name: existing?.name ?? input.email.split("@", 1)[0] ?? input.id,
      email: existing?.email ?? input.email,
      emailVerified: true,
      image: existing?.image ?? null,
      role: input.role,
      banned: input.status === "banned",
      banReason: input.status === "banned" ? "Scenario fixture" : null,
      banExpires: null,
      updatedAt: now,
    };
    if (existing) {
      await adapter.update<StoreUser>({
        model: "user",
        where: [{ field: "id", value: input.id }],
        update: values,
      });
    } else {
      // Fixture users are established users, who finished onboarding.
      await adapter.create({
        model: "user",
        data: { id: input.id, ...values, onboardedAt: now, createdAt: now },
        forceAllowId: true,
      });
    }
  }

  async #onboardScenarioUser(email: string) {
    const { adapter } = await this.#authContext();
    const now = new Date();
    await adapter.update<StoreUser>({
      model: "user",
      where: [{ field: "email", value: email.toLowerCase() }],
      update: { onboardedAt: now, updatedAt: now },
    });
  }

  async #setUpScenarioOrganization(input: {
    id: string;
    name: string;
    slug: string;
    ownerUserId: string;
    ownerRoles: readonly string[];
  }) {
    const { adapter } = await this.#authContext();
    const existing = await adapter.findOne<StoreOrganization>({
      model: "organization",
      where: [{ field: "id", value: input.id }],
    });
    const values = {
      name: input.name,
      slug: input.slug,
      logo: null,
      metadata: null,
      createdBy: input.ownerUserId,
      updatedAt: new Date(),
    };
    if (existing) {
      await adapter.update({
        model: "organization",
        where: [{ field: "id", value: input.id }],
        update: values,
      });
    } else {
      await adapter.create({
        model: "organization",
        data: { id: input.id, ...values, createdAt: new Date() },
        forceAllowId: true,
      });
    }
    await this.#setUpScenarioMember({
      organizationId: input.id,
      userId: input.ownerUserId,
      roles: input.ownerRoles,
    });
  }

  async #setUpScenarioMember(input: {
    organizationId: string;
    userId: string;
    roles: readonly string[];
  }) {
    const { adapter } = await this.#authContext();
    const existing = await adapter.findOne<StoreMember>({
      model: "member",
      where: [
        { field: "organizationId", value: input.organizationId },
        { field: "userId", value: input.userId },
      ],
    });
    if (existing) {
      await adapter.update({
        model: "member",
        where: [{ field: "id", value: existing.id }],
        update: { role: joinOrganizationRoles(input.roles) },
      });
      return;
    }
    await adapter.create({
      model: "member",
      data: {
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        userId: input.userId,
        role: joinOrganizationRoles(input.roles),
        createdAt: new Date(),
      },
      forceAllowId: true,
    });
  }

  async getScenarioMemberRoles(input: { organizationId: string; userId: string }) {
    const { adapter } = await this.#authContext();
    const member = await adapter.findOne<StoreMember>({
      model: "member",
      where: [
        { field: "organizationId", value: input.organizationId },
        { field: "userId", value: input.userId },
      ],
    });
    return member ? splitOrganizationRoles(member.role) : null;
  }

  async #removeScenarioMember(input: { organizationId: string; userId: string }) {
    const { adapter } = await this.#authContext();
    await adapter.delete({
      model: "member",
      where: [
        { field: "organizationId", value: input.organizationId },
        { field: "userId", value: input.userId },
      ],
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ready;
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/admin/grant") {
        return await this.#handleAdminGrantRequest(request);
      }
      const baseURL = resolveAuthBaseUrl(request);
      const auth = this.#getAuth(baseURL);
      const validatesOAuthResource =
        pathname.startsWith("/api/auth/oauth2/") || pathname.startsWith("/api/auth/device/");
      if (validatesOAuthResource) {
        await this.#initializeOAuthResource(auth, baseURL);
      }
      return await auth.handler(new Request(request, { redirect: "manual" }));
    } finally {
      await this.#scheduleNextHookAlarm();
    }
  }
}
