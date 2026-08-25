import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { DurableObject } from "cloudflare:workers";
import { Kysely } from "kysely";

import { extractW3CRequestPropagationContext } from "@fragno-dev/core";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type {
  AuthObject,
  GrantBackofficeAdminResult,
  ScenarioAuthFixture,
} from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import {
  type AuthHookContext,
  type AuthUser,
  type BackofficeCliOAuthConfig,
  type BackofficeCliTokenResult,
  type BackofficeMeData,
  joinOrganizationRoles,
  type Organization,
  type OrganizationHookPayload,
  type OrganizationHooks,
  type OrganizationInvitation,
  type OrganizationMember,
  type Role,
  resolveLiveAccessTokenSecret,
  splitOrganizationRoles,
  type UserAuthorityFacts,
  type UserSummary,
  type VerifyUserEmailInput,
  type VerifyUserEmailResult,
} from "@/fragno/auth/contracts";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import {
  AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED,
  AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED,
  AUTH_AUTOMATION_SOURCE,
} from "@/fragno/backoffice-capabilities/capabilities/auth";
import {
  createDurableHookRepositoryRpcTarget,
  type DurableHookQueueEntry,
  type DurableHookQueueResponse,
  type DurableHookRepository,
} from "@/fragno/durable-hooks";
import { buildUserEmailVerificationEmail } from "@/transactional-emails/user-email-verification";

import {
  ensureUserHasOrganization,
  type UserOrganizationDependencies,
} from "./auth-user-organization";
import {
  applyBackofficeBetterAuthSchemaMigrations,
  BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION,
} from "./auth/better-auth-migrations";
import {
  BackofficeTokenGrantForbiddenError,
  type BackofficeTokenGrantResolution,
  exchangeBackofficeOAuthAccessToken,
  getBackofficeCliOAuthConfig,
  initializeBackofficeCodemodeOAuthClient,
} from "./auth/better-auth-oauth";
import { createBackofficeTokenPlugin } from "./auth/better-auth-plugin";
import { createBackofficeBetterAuthSchemaPlugins } from "./auth/better-auth-schema-plugins";
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

type StoredDate = Date | string | number;

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

const toDate = (value: StoredDate): Date => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number") {
    return new Date(value < 10_000_000_000 ? value * 1_000 : value);
  }
  return new Date(value);
};

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

const toOrganizationMember = (member: StoreMember): OrganizationMember => ({
  id: member.id,
  organizationId: member.organizationId,
  userId: member.userId,
  roles: splitOrganizationRoles(member.role),
  createdAt: toDate(member.createdAt),
  updatedAt: toDate(member.createdAt),
});

const toOrganizationInvitation = (invitation: StoreInvitation): OrganizationInvitation => ({
  id: invitation.id,
  organizationId: invitation.organizationId,
  email: invitation.email,
  roles: splitOrganizationRoles(invitation.role),
  status: invitation.status,
  inviterId: invitation.inviterId,
  expiresAt: toDate(invitation.expiresAt),
  createdAt: toDate(invitation.createdAt),
});

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
  await runtime.objects.automations.singleton().ingestEvent(
    {
      id: context.hookId.toString(),
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
      subject: { orgId: organization.id },
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

const resolveAuthBaseUrl = (request: Request): string => {
  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedProto === "http" || forwardedProto === "https") {
    requestUrl.protocol = `${forwardedProto}:`;
  }
  return requestUrl.origin;
};

type BetterAuthInstance = Pick<ReturnType<typeof betterAuth>, "handler" | "options" | "$context">;
type BetterAuthContext = Awaited<ReturnType<typeof betterAuth>["$context"]>;
type CreateOrganizationEndpoint = (input: {
  body: { name: string; slug: string; userId: string };
}) => Promise<{ id: string; slug: string }>;
// Better Auth erases plugin endpoints when options are returned from a runtime factory. Keep the
// assertion at the plugin boundary instead of widening the type of the complete auth instance.
const getCreateOrganizationEndpoint = (auth: BetterAuthInstance): CreateOrganizationEndpoint =>
  (auth as unknown as { api: { createOrganization: CreateOrganizationEndpoint } }).api
    .createOrganization;
const getAuthContext = async (auth: BetterAuthInstance): Promise<BetterAuthContext> =>
  await auth.$context;

type BetterAuthAdapter = BetterAuthContext["adapter"];

const isOrganizationSlugConflict = (error: unknown): boolean => {
  if (
    error instanceof APIError &&
    error.status === "BAD_REQUEST" &&
    (error.body?.code === "ORGANIZATION_ALREADY_EXISTS" ||
      error.body?.message === "Organization already exists")
  ) {
    return true;
  }
  if (!(error instanceof Error) || !error.message.toLowerCase().includes("unique")) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("organization.slug") || message.includes("organization_slug");
};

const createBetterAuthUserOrganizationDependencies = (
  adapter: BetterAuthAdapter,
  createOrganization: CreateOrganizationEndpoint,
): UserOrganizationDependencies => ({
  async findFirstByUserId(userId) {
    const memberships = await adapter.findMany<StoreMember>({
      model: "member",
      where: [{ field: "userId", value: userId }],
    });
    memberships.sort((left, right) => {
      const createdAtDifference =
        toDate(left.createdAt).getTime() - toDate(right.createdAt).getTime();
      return createdAtDifference || left.id.localeCompare(right.id);
    });
    const membership = memberships[0];
    if (!membership) {
      return null;
    }
    const organization = await adapter.findOne<StoreOrganization>({
      model: "organization",
      where: [{ field: "id", value: membership.organizationId }],
    });
    if (!organization) {
      throw new Error(
        `Stored organization membership '${membership.id}' references missing organization '${membership.organizationId}'.`,
      );
    }
    return { id: organization.id, slug: organization.slug };
  },
  async findBySlug(slug) {
    const organization = await adapter.findOne<StoreOrganization>({
      model: "organization",
      where: [{ field: "slug", value: slug }],
    });
    return organization ? { id: organization.id, slug: organization.slug } : null;
  },
  async create(input) {
    try {
      const organization = await createOrganization({
        body: { name: input.name, slug: input.slug, userId: input.userId },
      });
      return {
        status: "created",
        organization: { id: organization.id, slug: organization.slug },
      };
    } catch (error) {
      if (isOrganizationSlugConflict(error)) {
        return { status: "slug_conflict" };
      }
      throw error;
    }
  },
});

const findStoreUser = async (
  adapter: BetterAuthAdapter,
  userId: string,
): Promise<StoreUser | null> =>
  await adapter.findOne<StoreUser>({
    model: "user",
    where: [{ field: "id", value: userId }],
  });

async function resolveBackofficeScopeTokenGrant(
  adapter: BetterAuthAdapter,
  input: {
    userId: string;
    scope: BackofficeContextScope | null;
    organizationSelection: "preferred" | "required";
  },
): Promise<BackofficeTokenGrantResolution> {
  const storedUser = await findStoreUser(adapter, input.userId);
  if (!storedUser || normalizeBoolean(storedUser.banned)) {
    throw new BackofficeTokenGrantForbiddenError(
      "This user cannot receive a Backoffice access token.",
    );
  }

  const globalRole = normalizeRole(storedUser.role);
  if (input.scope?.kind === "system") {
    if (globalRole !== "admin") {
      throw new BackofficeTokenGrantForbiddenError(
        "The requested system scope is not available to this user.",
      );
    }
    return {
      status: "ready",
      authority: {
        userId: storedUser.id,
        email: storedUser.email,
        globalRole,
        scope: input.scope,
        organization: null,
      },
    };
  }

  if (input.scope?.kind === "user") {
    if (input.scope.userId !== storedUser.id) {
      throw new BackofficeTokenGrantForbiddenError(
        "The requested user scope is not available to this user.",
      );
    }
    return {
      status: "ready",
      authority: {
        userId: storedUser.id,
        email: storedUser.email,
        globalRole,
        scope: input.scope,
        organization: null,
      },
    };
  }

  const memberships = await adapter.findMany<StoreMember>({
    model: "member",
    where: [{ field: "userId", value: storedUser.id }],
  });
  memberships.sort((left, right) => {
    const createdAtDifference =
      toDate(left.createdAt).getTime() - toDate(right.createdAt).getTime();
    return createdAtDifference || left.id.localeCompare(right.id);
  });

  const requestedOrganizationScope =
    input.scope?.kind === "org" || input.scope?.kind === "project" ? input.scope : null;
  const defaultMembership = memberships[0];
  if (!defaultMembership) {
    if (requestedOrganizationScope && input.organizationSelection === "required") {
      throw new BackofficeTokenGrantForbiddenError(
        "The requested Backoffice scope is not available to this user.",
      );
    }
    return { status: "organization_provisioning", retryAfterMs: 250 };
  }

  const requestedMembership = requestedOrganizationScope
    ? memberships.find(
        (membership) => membership.organizationId === requestedOrganizationScope.orgId,
      )
    : null;
  if (
    requestedOrganizationScope &&
    !requestedMembership &&
    input.organizationSelection === "required"
  ) {
    throw new BackofficeTokenGrantForbiddenError(
      "The requested Backoffice scope is not available to this user.",
    );
  }

  const selectedMembership = requestedMembership ?? defaultMembership;
  const selectedScope: BackofficeContextScope =
    requestedMembership && requestedOrganizationScope
      ? requestedOrganizationScope
      : { kind: "org", orgId: selectedMembership.organizationId };
  const selectedOrganization = await adapter.findOne<StoreOrganization>({
    model: "organization",
    where: [{ field: "id", value: selectedMembership.organizationId }],
  });
  if (!selectedOrganization) {
    throw new Error(
      `Stored organization membership '${selectedMembership.id}' references missing organization '${selectedMembership.organizationId}'.`,
    );
  }

  return {
    status: "ready",
    authority: {
      userId: storedUser.id,
      email: storedUser.email,
      globalRole,
      scope: selectedScope,
      organization: {
        id: selectedOrganization.id,
        slug: selectedOrganization.slug,
        roles: splitOrganizationRoles(selectedMembership.role),
      },
    },
  };
}

const buildBackofficeMe = async (
  adapter: BetterAuthAdapter,
  input: { userId: string; activeOrganizationId: string | null },
): Promise<BackofficeMeData | null> => {
  const storedUser = await findStoreUser(adapter, input.userId);
  if (!storedUser) {
    return null;
  }

  const memberships = await adapter.findMany<StoreMember>({
    model: "member",
    where: [{ field: "userId", value: input.userId }],
  });
  const organizations = await adapter.findMany<StoreOrganization>({
    model: "organization",
    where: memberships.length
      ? [{ field: "id", value: memberships.map((member) => member.organizationId), operator: "in" }]
      : [{ field: "id", value: "__none__" }],
  });
  const organizationById = new Map(
    organizations.map((organization) => [organization.id, organization]),
  );
  const mappedOrganizations = memberships.flatMap((member) => {
    const organization = organizationById.get(member.organizationId);
    return organization
      ? [{ organization: toOrganization(organization), member: toOrganizationMember(member) }]
      : [];
  });

  const invitations = await adapter.findMany<StoreInvitation>({
    model: "invitation",
    where: [
      { field: "email", value: storedUser.email.toLowerCase() },
      { field: "status", value: "pending" },
    ],
  });
  const invitationOrganizationIds = [
    ...new Set(invitations.map((invitation) => invitation.organizationId)),
  ];
  const invitationOrganizations = invitationOrganizationIds.length
    ? await adapter.findMany<StoreOrganization>({
        model: "organization",
        where: [{ field: "id", value: invitationOrganizationIds, operator: "in" }],
      })
    : [];
  const invitationOrganizationById = new Map(
    invitationOrganizations.map((organization) => [organization.id, organization]),
  );

  return {
    user: toAuthUser(storedUser),
    organizations: mappedOrganizations,
    activeOrganizationId: input.activeOrganizationId,
    activeOrganization:
      mappedOrganizations.find((entry) => entry.organization.id === input.activeOrganizationId) ??
      null,
    invitations: invitations.flatMap((invitation) => {
      const organization = invitationOrganizationById.get(invitation.organizationId);
      return organization
        ? [
            {
              invitation: toOrganizationInvitation(invitation),
              organization: toOrganization(organization),
            },
          ]
        : [];
    }),
  };
};

export class InMemoryAuthObject implements AuthObject {
  readonly #env: CloudflareEnv;
  readonly #state: BackofficeObjectState;
  readonly #runtime: BackofficeRuntimeServices;
  readonly #database: Kysely<AuthDatabase>;
  readonly #ready: Promise<void>;
  readonly #authByBaseUrl = new Map<string, BetterAuthInstance>();
  readonly #rateLimits = new Map<string, { key: string; count: number; windowStartedAt: number }>();
  #processingHooks: Promise<void> | null = null;

  constructor({
    state,
    env,
    runtime,
    database,
  }: {
    state: BackofficeObjectState;
    env: CloudflareEnv;
    runtime: BackofficeRuntimeServices;
    database?: Kysely<AuthDatabase>;
  }) {
    this.#env = env;
    this.#state = state;
    this.#runtime = runtime;

    if (!database && !(state.storage as DurableObjectStorage & { sql?: unknown }).sql) {
      throw new Error("Better Auth requires a SQLite database.");
    }
    this.#database =
      database ??
      new Kysely<AuthDatabase>({
        dialect: new DurableObjectDialect({ ctx: state as DurableObjectState }),
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
        await state.storage.put(
          AUTH_SCHEMA_VERSION_STORAGE_KEY,
          BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION,
        );
      }

      const auth = this.#getAuth("http://localhost");
      await initializeBackofficeCodemodeOAuthClient(auth);

      const nextHookWakeAt = await findNextBetterAuthDurableHookWakeAt(this.#database, {
        wakeImmediately: false,
      });
      if (nextHookWakeAt !== null) {
        await this.#state.storage.setAlarm(nextHookWakeAt);
      }
    });
  }

  #createOptions(baseURL: string): BetterAuthOptions {
    const runtime = this.#runtime;
    const emailVerification = runtime.config.authEmailVerification;
    const secret = resolveLiveAccessTokenSecret(this.#env, import.meta.env.MODE === "development");
    const isDevelopment = import.meta.env.MODE === "development";
    const schemaPlugins = createBackofficeBetterAuthSchemaPlugins({
      baseURL,
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
          return { data: { ...patch, updatedAt: new Date() } };
        },
      },
    });

    const backofficeTokenPlugin = createBackofficeTokenPlugin({
      isDevelopment,
      resolveBackofficeScopeTokenGrant,
    });

    const options = {
      appName: "Fragno Backoffice",
      baseURL,
      basePath: "/api/auth",
      secret,
      trustedOrigins: [baseURL],
      database: { db: this.#database, type: "sqlite" as const, transaction: true },
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 8,
        maxPasswordLength: 100,
        requireEmailVerification: emailVerification.enabled,
      },
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
        customStorage: {
          consume: async (key: string, rule: { window: number; max: number }) => {
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
                retryAfter: Math.ceil(
                  (current.windowStartedAt + windowInMilliseconds - now) / 1_000,
                ),
              };
            }

            this.#rateLimits.set(key, {
              ...current,
              count: current.count + 1,
            });
            return { allowed: true, retryAfter: null };
          },
        },
      },
      disabledPaths: ["/token"],
      advanced: {
        useSecureCookies: import.meta.env.MODE !== "development",
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
                role:
                  isRejotEmail(user.email) && import.meta.env.MODE === "development"
                    ? "admin"
                    : "user",
              },
            }),
          },
        },
      },
      plugins: [...schemaPlugins, backofficeTokenPlugin],
    } satisfies BetterAuthOptions;

    return options;
  }

  #getAuth(baseURL: string) {
    let auth = this.#authByBaseUrl.get(baseURL);
    if (!auth) {
      auth = betterAuth(this.#createOptions(baseURL));
      this.#authByBaseUrl.set(baseURL, auth);
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
      const auth = this.#getAuth("http://localhost");
      const authContext = await getAuthContext(auth);
      await ensureUserHasOrganization(
        record.payload.user,
        createBetterAuthUserOrganizationDependencies(
          authContext.adapter,
          getCreateOrganizationEndpoint(auth),
        ),
      );
      if (this.#runtime.config.authEmailVerification.enabled) {
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
    if (record.hookName === "onUserEmailVerificationRequested") {
      const payload = record.payload;
      const emailVerification = this.#runtime.config.authEmailVerification;
      if (!emailVerification.enabled) {
        return;
      }
      const verification = await this.#runtime.objects.otp.singleton().issueEmailVerification({
        userId: payload.user.id,
        email: payload.user.email,
        publicBaseUrl: emailVerification.publicBaseUrl,
        requestId: record.id,
      });
      if (!verification.deliverable) {
        return;
      }
      await this.#runtime.objects.resend.singleton().queueEmail(
        buildUserEmailVerificationEmail({
          email: payload.user.email,
          verificationUrl: verification.url,
          expiresInHours: verification.expiresInHours,
        }),
        { idempotencyKey: `auth:email-verification:${record.id}` },
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

  getDurableHookRepository(): DurableHookRepository {
    return createDurableHookRepositoryRpcTarget({
      getHookQueue: async (options = {}): Promise<DurableHookQueueResponse> => {
        const pageSize = Math.min(200, Math.max(1, options.pageSize ?? 50));
        const hooks = (
          await listBetterAuthDurableHooks(this.#database, {
            cursor: options.cursor ?? null,
            limit: pageSize + 1,
          })
        ).map(deserializeBetterAuthDurableHook);
        const start = 0;
        const items = hooks.slice(start, start + pageSize);
        const hasNextPage = hooks.length > start + pageSize;
        return {
          configured: true,
          hooksEnabled: true,
          namespace: "better-auth",
          items,
          cursor: hasNextPage ? items.at(-1)?.id : undefined,
          hasNextPage,
        };
      },
      getHook: async (hookId) => {
        const hook = await getBetterAuthDurableHook(this.#database, hookId);
        return hook ? deserializeBetterAuthDurableHook(hook) : null;
      },
    });
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
    return await buildBackofficeMe(adapter, input);
  }

  async getBackofficeCliOAuthConfig(input: {
    requestUrl: string;
  }): Promise<BackofficeCliOAuthConfig> {
    await this.#ready;
    const baseURL = new URL(input.requestUrl).origin;
    return await getBackofficeCliOAuthConfig(this.#getAuth(baseURL), input);
  }

  async exchangeBackofficeOAuthAccessToken(input: {
    requestUrl: string;
    oauthAccessToken: string;
    scope: BackofficeContextScope | null;
  }): Promise<BackofficeCliTokenResult> {
    await this.#ready;
    const baseURL = new URL(input.requestUrl).origin;
    return await exchangeBackofficeOAuthAccessToken(
      this.#getAuth(baseURL),
      input,
      resolveBackofficeScopeTokenGrant,
    );
  }

  async grantBackofficeAdminByEmail(input: { email: string }): Promise<GrantBackofficeAdminResult> {
    const { adapter } = await this.#authContext();
    const email = input.email.trim().toLowerCase();
    const user = await adapter.findOne<StoreUser>({
      model: "user",
      where: [{ field: "email", value: email }],
    });
    if (!user) {
      return { status: "user_not_found" };
    }
    if (normalizeBoolean(user.banned)) {
      return { status: "user_not_active" };
    }
    if (normalizeRole(user.role) === "admin") {
      return { status: "already_admin", userId: user.id };
    }

    await adapter.update<StoreUser>({
      model: "user",
      where: [{ field: "id", value: user.id }],
      update: { role: "admin", updatedAt: new Date() },
    });
    return { status: "granted", userId: user.id };
  }

  async getUserAuthorityFacts(input: {
    userId: string;
    organizationId?: string;
  }): Promise<UserAuthorityFacts> {
    const { adapter } = await this.#authContext();
    const user = await findStoreUser(adapter, input.userId);
    if (!user) {
      return { active: false, role: null, organizationMember: false };
    }
    const organizationMember = input.organizationId
      ? Boolean(
          await adapter.findOne({
            model: "member",
            where: [
              { field: "organizationId", value: input.organizationId },
              { field: "userId", value: input.userId },
            ],
          }),
        )
      : false;
    return {
      active: !normalizeBoolean(user.banned),
      role: normalizeRole(user.role),
      organizationMember,
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

  async getOrganizationBySlug(slug: string): Promise<Pick<Organization, "id" | "slug"> | null> {
    const { adapter } = await this.#authContext();
    const organization = await adapter.findOne<StoreOrganization>({
      model: "organization",
      where: [{ field: "slug", value: slug }],
    });
    return organization ? { id: organization.id, slug: organization.slug } : null;
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
      await adapter.create({
        model: "user",
        data: { id: input.id, ...values, createdAt: now },
        forceAllowId: true,
      });
    }
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
      return await this.#getAuth(resolveAuthBaseUrl(request)).handler(
        new Request(request, { redirect: "manual" }),
      );
    } finally {
      await this.#scheduleNextHookAlarm();
    }
  }
}

export class Auth extends DurableObject<CloudflareEnv> implements AuthObject {
  readonly #object: InMemoryAuthObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryAuthObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async alarm() {
    await this.#object.alarm();
  }

  getDurableHookRepository() {
    return this.#object.getDurableHookRepository();
  }

  async enqueueEmailVerificationHook(
    input: { userId: string; email: string },
    propagationContext?: Readonly<Record<string, string>> | null,
  ) {
    return await this.#object.enqueueEmailVerificationHook(input, propagationContext);
  }

  async enqueueOrganizationHook(
    hookName: "onOrganizationCreated" | "onOrganizationUpdated",
    payload: OrganizationHookPayload,
    propagationContext?: Readonly<Record<string, string>> | null,
  ) {
    return await this.#object.enqueueOrganizationHook(hookName, payload, propagationContext);
  }

  async verifyUserEmail(input: VerifyUserEmailInput): Promise<VerifyUserEmailResult> {
    return await this.#object.verifyUserEmail(input);
  }

  async getBackofficeMe(input: {
    userId: string;
    activeOrganizationId: string | null;
  }): Promise<BackofficeMeData | null> {
    return await this.#object.getBackofficeMe(input);
  }

  async getBackofficeCliOAuthConfig(input: {
    requestUrl: string;
  }): Promise<BackofficeCliOAuthConfig> {
    return await this.#object.getBackofficeCliOAuthConfig(input);
  }

  async exchangeBackofficeOAuthAccessToken(input: {
    requestUrl: string;
    oauthAccessToken: string;
    scope: BackofficeContextScope | null;
  }): Promise<BackofficeCliTokenResult> {
    return await this.#object.exchangeBackofficeOAuthAccessToken(input);
  }

  async getUserAuthorityFacts(input: { userId: string; organizationId?: string }) {
    return await this.#object.getUserAuthorityFacts(input);
  }

  async grantBackofficeAdminByEmail(input: { email: string }) {
    return await this.#object.grantBackofficeAdminByEmail(input);
  }

  async getAllOrganizations() {
    return await this.#object.getAllOrganizations();
  }

  async getOrganizationBySlug(slug: string) {
    return await this.#object.getOrganizationBySlug(slug);
  }

  async hasOrganizationMember(input: { organizationId: string; userId: string }) {
    return await this.#object.hasOrganizationMember(input);
  }

  async getDevOrganizations() {
    return await this.#object.getDevOrganizations();
  }

  async applyScenarioFixture(fixture: ScenarioAuthFixture) {
    await this.#object.applyScenarioFixture(fixture);
  }

  async getScenarioMemberRoles(input: { organizationId: string; userId: string }) {
    return await this.#object.getScenarioMemberRoles(input);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
