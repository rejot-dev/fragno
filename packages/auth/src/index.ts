import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import type { StandardSchemaV1 } from "@standard-schema/spec";

import { verifyAuthAccessTokenFromRequest } from "./auth/request-access-token";
import {
  resolveAccessTokenConfig,
  verifySessionAccessTokenDetailed,
  type ResolvedSessionAccessTokenConfig,
} from "./auth/session-access-token";
import type { AuthCredentialSource, AuthPrincipal, RequestAuthFailureReason } from "./auth/types";
import {
  clearDefaultOrganizationId,
  createDefaultOrganizationPreferenceState,
  DEFAULT_ORGANIZATION_CHANGE_EVENT,
  DEFAULT_ORGANIZATION_STORAGE_KEY,
  findOrganizationEntry,
  getDefaultOrganizationChangeEventName,
  getDefaultOrganizationStorageKey,
  NO_ORGANIZATIONS_ERROR_MESSAGE,
  readDefaultOrganizationId,
  resolveDefaultOrganization,
  setDefaultOrganizationForMe,
  subscribeToDefaultOrganizationPreference,
  syncDefaultOrganizationPreference,
  writeDefaultOrganizationId,
  type AuthMeLike as AuthDefaultOrganizationMeLike,
  type DefaultOrganizationEntry as AuthDefaultOrganizationEntry,
  type DefaultOrganizationResolution as AuthDefaultOrganizationResolution,
  type DefaultOrganizationResolutionStatus,
} from "./client/default-organization";
import {
  clearAuthSessionCache,
  isAuthSessionCacheFresh,
  readAuthSessionCache,
  writeAuthSessionCache,
  type AuthSessionCacheOptions,
} from "./client/session-cache";
import {
  readStorageItem,
  removeStorageItem,
  writeStorageItem,
  type StorageLike,
} from "./client/storage";
import type { AuthEmailVerificationConfig } from "./email-verification-policy";
import type {
  AuthHooks,
  AuthHooksMap,
  BeforeCreateUserHook,
  CredentialHookPayload,
  DurableUserCreatedHookPayload,
  DurableUserEmailVerifiedHookPayload,
  InvitationExpiredHookPayload,
  UserHookPayload,
} from "./hooks";
import { createOAuthServices } from "./oauth/oauth-services";
import { oauthRoutesFactory } from "./oauth/routes";
import type { AuthOAuthConfig } from "./oauth/types";
import { createActiveOrganizationServices } from "./organization/active-organization";
import { createAdminOrganizationServices } from "./organization/admin-organization-services";
import { createOrganizationInvitationServices } from "./organization/invitation-services";
import { createOrganizationMemberServices } from "./organization/member-services";
import { createOrganizationServices } from "./organization/organization-services";
import { organizationRoutesFactory } from "./organization/routes";
import type {
  DefaultOrganizationRole,
  OrganizationConfig,
  OrganizationHookPayload,
  OrganizationHooks,
  OrganizationInvitationHookPayload,
  OrganizationMemberHookPayload,
  OrganizationInvitationStatus,
} from "./organization/types";
import { toExternalId } from "./organization/utils";
import { authSchema } from "./schema";
import { createSessionServices, sessionRoutesFactory } from "./session/session";
import { serializeCredentialSeedForQuery } from "./session/session-seed";
import type { Role } from "./types";
import { createUserServices, userActionsRoutesFactory } from "./user/user-actions";
import {
  createUserOverviewServices,
  userOverviewRoutesFactory,
  type GetUsersParams,
  type UserResult,
  type SortField,
  type SortOrder,
} from "./user/user-overview";
import type { CookieOptions } from "./utils/cookie";

export interface AuthSessionSnapshot<TSessionContext = unknown> {
  session: {
    id: string;
    expiresAt: Date | null;
    activeOrganizationId: string | null;
    context: TSessionContext;
  };
  user: {
    id: string;
    email: string;
    role: Role;
  };
  organizationIds: string[];
}

export interface ProjectAccessTokenContextInput<TSessionContext = unknown> {
  snapshot: AuthSessionSnapshot<TSessionContext>;
}

export interface AuthConfig<
  TRole extends string = DefaultOrganizationRole,
  TSessionContext = unknown,
  TAccessTokenContext = unknown,
> {
  authentication?: {
    strategy?: "session";
    accessTokens?: {
      enabled?: boolean;
      issuer: string;
      audience: string;
      secret: string;
      expiresInSeconds?: number;
      acceptBearer?: boolean;
      issueCookie?: boolean;
      context?: {
        schema: StandardSchemaV1<unknown, TAccessTokenContext>;
        project: (
          input: ProjectAccessTokenContextInput<TSessionContext>,
        ) => TAccessTokenContext | null;
        maxBytes?: number;
      };
    };
  };
  sessionContext?: {
    schema: StandardSchemaV1<unknown, TSessionContext>;
  };
  cookieOptions?: CookieOptions;
  emailVerification?: AuthEmailVerificationConfig;
  hooks?: AuthHooks;
  beforeCreateUser?: BeforeCreateUserHook;
  organizations?: OrganizationConfig<TRole> | false;
  emailAndPassword?: {
    enabled?: boolean;
  };
  oauth?: AuthOAuthConfig;
}

const parseDurableHookDate = (value: string, fieldName: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`Invalid ${fieldName} durable hook timestamp.`);
  }
  return date;
};

export const authFragmentDefinition = defineFragment<AuthConfig>("auth")
  .extend(withDatabase(authSchema))
  .provideHooks<AuthHooksMap>(({ defineHook, config }) => {
    const authHooks = config.hooks;
    const organizationConfig = config.organizations === false ? undefined : config.organizations;
    const organizationHooks = organizationConfig?.hooks as OrganizationHooks<string> | undefined;

    const mapOrganization = (organization: {
      id: unknown;
      name: string;
      slug: string;
      logoUrl: string | null;
      metadata: unknown;
      createdBy: unknown;
      organizationCreator?: { id?: unknown } | null;
      createdAt: Date;
      updatedAt: Date;
      deletedAt: Date | null;
    }) => ({
      id: toExternalId(organization.id),
      name: organization.name,
      slug: organization.slug,
      logoUrl: organization.logoUrl ?? null,
      metadata: (organization.metadata ?? null) as Record<string, unknown> | null,
      createdBy: toExternalId(organization.organizationCreator?.id ?? organization.createdBy),
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
      deletedAt: organization.deletedAt ?? null,
    });

    const mapInvitation = (invitation: {
      id: unknown;
      organizationId: unknown;
      email: string;
      roles: unknown;
      status: string;
      token: string;
      inviterId: unknown;
      expiresAt: Date;
      createdAt: Date;
      respondedAt: Date | null;
    }) => ({
      id: toExternalId(invitation.id),
      organizationId: toExternalId(invitation.organizationId),
      email: invitation.email,
      roles: Array.isArray(invitation.roles) ? (invitation.roles as string[]) : [],
      status: invitation.status as OrganizationInvitationStatus,
      token: invitation.token,
      inviterId: toExternalId(invitation.inviterId),
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      respondedAt: invitation.respondedAt ?? null,
    });

    const hookContext = (context: { idempotencyKey: string; hookId: { toString(): string } }) => ({
      idempotencyKey: context.idempotencyKey,
      hookId: context.hookId.toString(),
    });

    const baseHooks = {
      onUserCreated: defineHook<DurableUserCreatedHookPayload>(async function (payload) {
        const emailVerifiedAt =
          payload.emailVerifiedAt === null
            ? null
            : parseDurableHookDate(payload.emailVerifiedAt, "onUserCreated.emailVerifiedAt");
        await authHooks?.onUserCreated?.({ ...payload, emailVerifiedAt }, hookContext(this));
      }),
      onUserEmailVerified: defineHook<DurableUserEmailVerifiedHookPayload>(
        async function (payload) {
          const emailVerifiedAt = parseDurableHookDate(
            payload.emailVerifiedAt,
            "onUserEmailVerified.emailVerifiedAt",
          );
          await authHooks?.onUserEmailVerified?.(
            { ...payload, emailVerifiedAt },
            hookContext(this),
          );
        },
      ),
      onUserRoleUpdated: defineHook<UserHookPayload>(async function (payload) {
        await authHooks?.onUserRoleUpdated?.(payload, hookContext(this));
      }),
      onUserPasswordChanged: defineHook<UserHookPayload>(async function (payload) {
        await authHooks?.onUserPasswordChanged?.(payload, hookContext(this));
      }),
      onCredentialIssued: defineHook<CredentialHookPayload>(async function (payload) {
        await authHooks?.onCredentialIssued?.(payload, hookContext(this));
      }),
      onCredentialInvalidated: defineHook<CredentialHookPayload>(async function (payload) {
        await authHooks?.onCredentialInvalidated?.(payload, hookContext(this));
      }),
    };

    return {
      ...baseHooks,
      onOrganizationCreated: defineHook<OrganizationHookPayload>(async function (payload) {
        await organizationHooks?.onOrganizationCreated?.(payload, hookContext(this));
      }),
      onOrganizationUpdated: defineHook<OrganizationHookPayload>(async function (payload) {
        await organizationHooks?.onOrganizationUpdated?.(payload, hookContext(this));
      }),
      onOrganizationDeleted: defineHook<OrganizationHookPayload>(async function (payload) {
        await organizationHooks?.onOrganizationDeleted?.(payload, hookContext(this));
      }),
      onMemberAdded: defineHook<OrganizationMemberHookPayload<string>>(async function (payload) {
        await organizationHooks?.onMemberAdded?.(payload, hookContext(this));
      }),
      onMemberRemoved: defineHook<OrganizationMemberHookPayload<string>>(async function (payload) {
        await organizationHooks?.onMemberRemoved?.(payload, hookContext(this));
      }),
      onMemberRolesUpdated: defineHook<OrganizationMemberHookPayload<string>>(
        async function (payload) {
          await organizationHooks?.onMemberRolesUpdated?.(payload, hookContext(this));
        },
      ),
      onInvitationCreated: defineHook<OrganizationInvitationHookPayload<string>>(
        async function (payload) {
          await organizationHooks?.onInvitationCreated?.(payload, hookContext(this));
        },
      ),
      onInvitationAccepted: defineHook<OrganizationInvitationHookPayload<string>>(
        async function (payload) {
          await organizationHooks?.onInvitationAccepted?.(payload, hookContext(this));
        },
      ),
      onInvitationRejected: defineHook<OrganizationInvitationHookPayload<string>>(
        async function (payload) {
          await organizationHooks?.onInvitationRejected?.(payload, hookContext(this));
        },
      ),
      onInvitationCanceled: defineHook<OrganizationInvitationHookPayload<string>>(
        async function (payload) {
          await organizationHooks?.onInvitationCanceled?.(payload, hookContext(this));
        },
      ),
      onInvitationExpired: defineHook<InvitationExpiredHookPayload>(async function (payload) {
        if (!payload.invitationId) {
          return;
        }

        const now = new Date();
        const result = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(authSchema).findFirst("organizationInvitation", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "=", payload.invitationId))
                .joinOne("organizationInvitationOrganization", "organization", (organization) =>
                  organization
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("organizationId")))
                    .joinOne("organizationCreator", "user", (creator) =>
                      creator.onIndex("primary", (eb) => eb("id", "=", eb.parent("createdBy"))),
                    ),
                ),
            ),
          )
          .mutate(({ forSchema, retrieveResult: [invitation] }) => {
            if (!invitation) {
              return { shouldNotify: false as const };
            }

            const status = invitation.status as OrganizationInvitationStatus;
            if (status !== "pending") {
              return { shouldNotify: false as const };
            }

            if (invitation.expiresAt.getTime() > now.getTime()) {
              return { shouldNotify: false as const };
            }

            const uow = forSchema(authSchema);
            uow.update("organizationInvitation", invitation.id, (b) =>
              b.set({ status: "expired", respondedAt: now }).check(),
            );

            if (!invitation.organizationInvitationOrganization) {
              return { shouldNotify: false as const };
            }

            return {
              shouldNotify: true as const,
              organization: mapOrganization(invitation.organizationInvitationOrganization),
              invitation: mapInvitation({
                id: invitation.id,
                organizationId: invitation.organizationId,
                email: invitation.email,
                roles: invitation.roles,
                status: "expired",
                token: invitation.token,
                inviterId: invitation.inviterId,
                expiresAt: invitation.expiresAt,
                createdAt: invitation.createdAt,
                respondedAt: now,
              }),
            };
          })
          .transform(({ mutateResult }) => mutateResult)
          .execute();

        if (result.shouldNotify) {
          await organizationHooks?.onInvitationExpired?.(
            {
              organization: result.organization,
              invitation: result.invitation,
              actor: null,
            },
            hookContext(this),
          );
        }
      }),
    };
  })
  .providesBaseService(({ defineService, config }) => {
    const organizationsEnabled = config.organizations !== false;
    const organizationConfig = config.organizations === false ? undefined : config.organizations;

    const organizationConfigResolved = organizationConfig as OrganizationConfig<string> | undefined;
    const autoCreateOptions = organizationsEnabled
      ? {
          autoCreateOrganization:
            organizationConfig && organizationConfig.autoCreateOrganization !== false
              ? organizationConfig.autoCreateOrganization
              : undefined,
          creatorRoles: organizationConfig?.creatorRoles,
        }
      : undefined;

    return defineService({
      ...createUserServices(autoCreateOptions, config.beforeCreateUser, config.emailVerification),
      ...createSessionServices(config.cookieOptions, config.emailVerification),
      ...createUserOverviewServices(),
      ...createAdminOrganizationServices(),
      ...createOrganizationServices({
        organizationConfig: organizationConfigResolved,
        emailVerification: config.emailVerification,
      }),
      ...createOrganizationMemberServices({
        organizationConfig: organizationConfigResolved,
        emailVerification: config.emailVerification,
      }),
      ...createOrganizationInvitationServices({
        organizationConfig: organizationConfigResolved,
        emailVerification: config.emailVerification,
      }),
      ...createActiveOrganizationServices(config.emailVerification),
      accessTokens: createAuthAccessTokenMethods(config),
      ...createOAuthServices({
        oauth: config.oauth,
        autoCreateOptions,
        beforeCreateUser: config.beforeCreateUser,
        emailVerification: config.emailVerification,
      }),
    });
  })
  .build();

export type AuthFragmentDefinition = typeof authFragmentDefinition;

export type AuthFragment = typeof authFragmentDefinition;

const buildAuthFragment = (
  config: AuthConfig = {},
  fragnoConfig: FragnoPublicConfigWithDatabase,
) => {
  const options = {
    ...fragnoConfig,
    // Preserve legacy namespace to avoid changing physical table names.
    databaseNamespace:
      fragnoConfig.databaseNamespace !== undefined
        ? fragnoConfig.databaseNamespace
        : "simple-auth-db",
  };

  return instantiate(authFragmentDefinition)
    .withConfig(config)
    .withOptions(options)
    .withRoutes([
      userActionsRoutesFactory,
      sessionRoutesFactory,
      userOverviewRoutesFactory,
      organizationRoutesFactory,
      oauthRoutesFactory,
    ])
    .build();
};

export type AuthAccessTokenVerificationResult =
  | { ok: true; principal: AuthPrincipal }
  | { ok: false; reason: "disabled" | RequestAuthFailureReason | "expired" };

export interface AuthAccessTokenMethods {
  config: ResolvedSessionAccessTokenConfig | null;
  verify(input: {
    token: string;
    source?: AuthCredentialSource;
  }): Promise<AuthAccessTokenVerificationResult>;
  verifyRequest(input: {
    headers: Headers;
    cookieOptions?: CookieOptions;
  }): Promise<AuthAccessTokenVerificationResult>;
}

export type AuthFragmentInstance = ReturnType<typeof buildAuthFragment>;

export function createAuthAccessTokenMethods(config: AuthConfig): AuthAccessTokenMethods {
  const accessTokens = resolveAccessTokenConfig(config.authentication?.accessTokens);

  return {
    config: accessTokens,
    async verify({ token, source = "authorization-header" }) {
      if (!accessTokens) {
        return { ok: false, reason: "disabled" };
      }

      if (source === "authorization-header" && !accessTokens.acceptBearer) {
        return { ok: false, reason: "invalid" };
      }
      if (source === "cookie" && !accessTokens.issueCookie) {
        return { ok: false, reason: "invalid" };
      }

      const result = await verifySessionAccessTokenDetailed({
        config: accessTokens,
        token,
        source,
      });
      return result.ok ? { ok: true, principal: result.principal } : result;
    },
    async verifyRequest({ headers, cookieOptions }) {
      if (!accessTokens) {
        return { ok: false, reason: "disabled" };
      }

      return verifyAuthAccessTokenFromRequest({
        headers,
        accessTokens,
        cookieOptions,
      });
    },
  };
}

export function createAuthFragment(
  config: AuthConfig = {},
  fragnoConfig: FragnoPublicConfigWithDatabase,
): AuthFragmentInstance {
  return buildAuthFragment(config, fragnoConfig);
}

export type AuthClientAccessTokenTransport = "cookie" | "bearer" | "cookie-and-bearer";

const DEFAULT_AUTH_ACCESS_TOKEN_STORAGE_KEY = "fragno_auth_access_token";

const shouldUseBearerTransport = (transport?: AuthClientAccessTokenTransport) =>
  transport === "bearer" || transport === "cookie-and-bearer";

const extractAuthAccessToken = (value: unknown): string | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const auth = (value as { auth?: unknown }).auth;
  if (!auth || typeof auth !== "object") {
    return null;
  }

  const token = (auth as { token?: unknown }).token;
  return typeof token === "string" && token.length > 0 ? token : null;
};

const createBearerAccessTokenFetcher = (input: {
  fetcherConfig: FragnoPublicClientConfig["fetcherConfig"];
  storage?: StorageLike | null;
  storageKey?: string;
}): typeof fetch => {
  const tokenStorageKey = input.storageKey ?? DEFAULT_AUTH_ACCESS_TOKEN_STORAGE_KEY;
  const fetcher =
    input.fetcherConfig?.type === "function"
      ? input.fetcherConfig.fetcher
      : globalThis.fetch.bind(globalThis);
  const defaultOptions =
    input.fetcherConfig?.type === "options" ? input.fetcherConfig.options : undefined;

  return async (resource, init) => {
    const storedToken = readStorageItem(tokenStorageKey, input.storage);
    const headers = new Headers(defaultOptions?.headers);
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });

    if (storedToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${storedToken}`);
    }

    const response = await fetcher(resource, {
      ...defaultOptions,
      ...init,
      headers,
    });

    if (response.ok) {
      const token = extractAuthAccessToken(await response.clone().json());
      if (token) {
        writeStorageItem(tokenStorageKey, token, input.storage);
      }
    }

    return response;
  };
};

export interface AuthClientSessionCacheConfig {
  enabled?: boolean;
  storage?: StorageLike | null;
  storageKey?: string;
  ttlSeconds?: number;
}

export interface AuthClientAuthConfig {
  accessTokens?: {
    enabled?: boolean;
    transport?: AuthClientAccessTokenTransport;
  };
  sessionCache?: AuthClientSessionCacheConfig;
}

export type AuthFragmentClientConfig = FragnoPublicClientConfig & { auth?: AuthClientAuthConfig };

export function createAuthFragmentClients(fragnoConfig?: AuthFragmentClientConfig) {
  // Note: Cookies are automatically sent for same-origin requests by the browser.
  // For cross-origin requests, you may need to configure CORS headers on the server.
  const { auth: authClientConfig, ...config } = { ...fragnoConfig };
  const sessionCacheConfig = authClientConfig?.sessionCache;
  const sessionCacheEnabled =
    authClientConfig?.accessTokens?.enabled === true && sessionCacheConfig?.enabled === true;
  const sessionCacheOptions: AuthSessionCacheOptions = {
    storage: sessionCacheConfig?.storage,
    storageKey: sessionCacheConfig?.storageKey,
    ttlSeconds: sessionCacheConfig?.ttlSeconds,
  };
  const accessTokenTransport = authClientConfig?.accessTokens?.transport ?? "cookie";
  const bearerAccessTokensEnabled =
    authClientConfig?.accessTokens?.enabled === true &&
    shouldUseBearerTransport(accessTokenTransport);
  const bearerAccessTokenStorage = sessionCacheConfig?.storage;
  const bearerAccessTokenStorageKey = DEFAULT_AUTH_ACCESS_TOKEN_STORAGE_KEY;
  const clientConfig: FragnoPublicClientConfig = bearerAccessTokensEnabled
    ? {
        ...config,
        fetcherConfig: {
          type: "function",
          fetcher: createBearerAccessTokenFetcher({
            fetcherConfig: config.fetcherConfig,
            storage: bearerAccessTokenStorage,
            storageKey: bearerAccessTokenStorageKey,
          }),
          useOnServer:
            config.fetcherConfig?.type === "function"
              ? config.fetcherConfig.useOnServer
              : undefined,
        },
      }
    : config;

  const b = createClientBuilder(
    authFragmentDefinition,
    clientConfig,
    [
      userActionsRoutesFactory,
      sessionRoutesFactory,
      userOverviewRoutesFactory,
      organizationRoutesFactory,
      oauthRoutesFactory,
    ],
    {
      type: "options",
      options: {
        credentials: "include",
      },
    },
  );

  const useMe = b.createHook("/me");
  const useSignUp = b.createMutator("POST", "/sign-up");
  const useSignIn = b.createMutator("POST", "/sign-in");
  const useSignOut = b.createMutator("POST", "/sign-out", (invalidate) => {
    invalidate("GET", "/me", {});
    invalidate("GET", "/users", {});
  });
  const useUsers = b.createHook("/users");
  const useUpdateUserRole = b.createMutator("PATCH", "/users/:userId/role", (invalidate) => {
    invalidate("GET", "/users", {});
    invalidate("GET", "/me", {});
  });
  const useChangePassword = b.createMutator("POST", "/change-password");
  const useOrganizations = b.createHook("/organizations");
  const useOrganization = b.createHook("/organizations/:organizationId");
  const useCreateOrganization = b.createMutator("POST", "/organizations", (invalidate) => {
    invalidate("GET", "/organizations", {});
    invalidate("GET", "/organizations/active", {});
    invalidate("GET", "/me", {});
  });
  const useUpdateOrganization = b.createMutator(
    "PATCH",
    "/organizations/:organizationId",
    (invalidate, params) => {
      const organizationId = params.pathParams.organizationId;
      if (organizationId) {
        invalidate("GET", "/organizations/:organizationId", {
          pathParams: { organizationId },
        });
        invalidate("GET", "/organizations/:organizationId/members", {
          pathParams: { organizationId },
        });
        invalidate("GET", "/organizations/:organizationId/invitations", {
          pathParams: { organizationId },
        });
      }
      invalidate("GET", "/organizations", {});
      invalidate("GET", "/organizations/active", {});
      invalidate("GET", "/me", {});
    },
  );
  const useDeleteOrganization = b.createMutator(
    "DELETE",
    "/organizations/:organizationId",
    (invalidate, params) => {
      const organizationId = params.pathParams.organizationId;
      if (organizationId) {
        invalidate("GET", "/organizations/:organizationId", {
          pathParams: { organizationId },
        });
        invalidate("GET", "/organizations/:organizationId/members", {
          pathParams: { organizationId },
        });
        invalidate("GET", "/organizations/:organizationId/invitations", {
          pathParams: { organizationId },
        });
      }
      invalidate("GET", "/organizations", {});
      invalidate("GET", "/organizations/active", {});
      invalidate("GET", "/me", {});
    },
  );
  const useActiveOrganization = b.createHook("/organizations/active");
  const useSetActiveOrganization = b.createMutator(
    "POST",
    "/organizations/active",
    (invalidate) => {
      invalidate("GET", "/organizations/active", {});
      invalidate("GET", "/me", {});
    },
  );
  const useOrganizationMembers = b.createHook("/organizations/:organizationId/members");
  const useAddOrganizationMember = b.createMutator(
    "POST",
    "/organizations/:organizationId/members",
    (invalidate, params) => {
      const organizationId = params.pathParams.organizationId;
      if (!organizationId) {
        return;
      }
      invalidate("GET", "/organizations/:organizationId/members", {
        pathParams: { organizationId },
      });
      invalidate("GET", "/organizations/:organizationId", {
        pathParams: { organizationId },
      });
      invalidate("GET", "/organizations", {});
      invalidate("GET", "/me", {});
    },
  );
  const useUpdateOrganizationMemberRoles = b.createMutator(
    "PATCH",
    "/organizations/:organizationId/members/:memberId",
    (invalidate, params) => {
      const organizationId = params.pathParams.organizationId;
      if (!organizationId) {
        return;
      }
      invalidate("GET", "/organizations/:organizationId/members", {
        pathParams: { organizationId },
      });
      invalidate("GET", "/organizations/:organizationId", {
        pathParams: { organizationId },
      });
      invalidate("GET", "/organizations", {});
      invalidate("GET", "/me", {});
    },
  );
  const useRemoveOrganizationMember = b.createMutator(
    "DELETE",
    "/organizations/:organizationId/members/:memberId",
    (invalidate, params) => {
      const organizationId = params.pathParams.organizationId;
      if (!organizationId) {
        return;
      }
      invalidate("GET", "/organizations/:organizationId/members", {
        pathParams: { organizationId },
      });
      invalidate("GET", "/organizations/:organizationId", {
        pathParams: { organizationId },
      });
      invalidate("GET", "/organizations", {});
      invalidate("GET", "/me", {});
    },
  );
  const useOrganizationInvitations = b.createHook("/organizations/:organizationId/invitations");
  const useInviteOrganizationMember = b.createMutator(
    "POST",
    "/organizations/:organizationId/invitations",
    (invalidate, params) => {
      const organizationId = params.pathParams.organizationId;
      if (!organizationId) {
        return;
      }
      invalidate("GET", "/organizations/:organizationId/invitations", {
        pathParams: { organizationId },
      });
    },
  );
  const useRespondOrganizationInvitation = b.createMutator(
    "PATCH",
    "/organizations/invitations/:invitationId",
    (invalidate) => {
      invalidate("GET", "/organizations/invitations", {});
      invalidate("GET", "/organizations", {});
      invalidate("GET", "/organizations/active", {});
      invalidate("GET", "/me", {});
    },
  );
  const useUserInvitations = b.createHook("/organizations/invitations");
  const useOAuthAuthorize = b.createHook("/oauth/:provider/authorize");
  const useOAuthCallback = b.createHook("/oauth/:provider/callback");
  type ClientMeResponse = Awaited<ReturnType<typeof useMe.query>>;
  const writeMeSessionCache = (me: ClientMeResponse) => {
    if (!sessionCacheEnabled) {
      return;
    }
    writeAuthSessionCache(
      {
        me,
        updatedAt: new Date().toISOString(),
        expiresAt: null,
        activeOrganizationId: me.activeOrganization?.organization.id ?? null,
      },
      sessionCacheOptions,
    );
  };
  const clearMeSessionCache = () => {
    if (sessionCacheEnabled) {
      clearAuthSessionCache(sessionCacheOptions);
    }
  };
  const readRawMe = async () => {
    if (sessionCacheEnabled) {
      const cached = readAuthSessionCache<ClientMeResponse>(sessionCacheOptions);
      if (cached && isAuthSessionCacheFresh(cached, new Date(), sessionCacheOptions)) {
        return cached.me;
      }
    }

    try {
      const me = await useMe.query();
      writeMeSessionCache(me);
      return me;
    } catch (error) {
      clearMeSessionCache();
      throw error;
    }
  };
  const defaultOrganizationPreference = createDefaultOrganizationPreferenceState({
    meStore: useMe.store(),
    readMe: readRawMe,
    getAccountId: (me) => me.user.id,
  });

  return {
    // Reactive hooks - Auth
    useSignUp,
    useSignIn,
    useSignOut,
    useMe,
    useDefaultOrganizationPreference: b.createStore(defaultOrganizationPreference.store),
    useUsers,
    useUpdateUserRole,
    useChangePassword,
    useOrganizations,
    useOrganization,
    useCreateOrganization,
    useUpdateOrganization,
    useDeleteOrganization,
    useActiveOrganization,
    useSetActiveOrganization,
    useOrganizationMembers,
    useAddOrganizationMember,
    useUpdateOrganizationMemberRoles,
    useRemoveOrganizationMember,
    useOrganizationInvitations,
    useInviteOrganizationMember,
    useRespondOrganizationInvitation,
    useUserInvitations,
    useOAuthAuthorize,
    useOAuthCallback,

    // Non-reactive methods
    signIn: {
      email: async ({
        email,
        password,
        auth,
        rememberMe: _rememberMe,
      }: {
        email: string;
        password: string;
        auth?: {
          activeOrganizationId?: string;
        };
        rememberMe?: boolean;
      }) => {
        // Note: rememberMe is accepted but not yet implemented on the backend
        const result = await useSignIn.mutateQuery({
          body: {
            email,
            password,
            auth,
          },
        });
        if (sessionCacheEnabled) {
          try {
            writeMeSessionCache(await useMe.query());
          } catch {
            clearMeSessionCache();
          }
        }
        return result;
      },
    },

    signUp: {
      email: async ({ email, password }: { email: string; password: string }) => {
        const result = await useSignUp.mutateQuery({
          body: {
            email,
            password,
          },
        });
        if (sessionCacheEnabled) {
          try {
            writeMeSessionCache(await useMe.query());
          } catch {
            clearMeSessionCache();
          }
        }
        return result;
      },
    },

    signOut: async () => {
      try {
        return await useSignOut.mutateQuery({
          body: {},
        });
      } finally {
        clearMeSessionCache();
        if (bearerAccessTokensEnabled) {
          removeStorageItem(bearerAccessTokenStorageKey, bearerAccessTokenStorage);
        }
      }
    },

    me: defaultOrganizationPreference.me,

    defaultOrganization: defaultOrganizationPreference.defaultOrganization,

    oauth: {
      getAuthorizationUrl: async (params: {
        provider: string;
        returnTo?: string;
        link?: boolean;
        auth?: {
          activeOrganizationId?: string;
        };
        redirectUri?: string;
        scope?: string;
        loginHint?: string;
      }) => {
        return useOAuthAuthorize.query({
          path: { provider: params.provider },
          query: {
            redirectUri: params.redirectUri,
            returnTo: params.returnTo,
            link: params.link ? "true" : undefined,
            auth: serializeCredentialSeedForQuery(params.auth),
            scope: params.scope,
            loginHint: params.loginHint,
          },
        });
      },
      callback: async (params: {
        provider: string;
        code: string;
        state: string;
        requestSignUp?: boolean;
      }) => {
        const result = await useOAuthCallback.query({
          path: { provider: params.provider },
          query: {
            code: params.code,
            state: params.state,
            requestSignUp: params.requestSignUp ? "true" : undefined,
          },
        });
        if (sessionCacheEnabled) {
          try {
            writeMeSessionCache(await useMe.query());
          } catch {
            clearMeSessionCache();
          }
        }
        return result;
      },
    },
  };
}

export type { FragnoRouteConfig } from "@fragno-dev/core/api";
export type { GetUsersParams, UserResult, SortField, SortOrder };
export type AuthMeData = Awaited<ReturnType<ReturnType<typeof createAuthFragmentClients>["me"]>>;
export type {
  AuthHookContext,
  AuthHooks,
  BeforeCreateUserHook,
  BeforeCreateUserPayload,
  CredentialHookPayload,
  CredentialSummary,
  DurableUserCreatedHookPayload,
  DurableUserEmailVerifiedHookPayload,
  InvitationExpiredHookPayload,
  UserCreatedHookPayload,
  UserEmailVerifiedHookPayload,
  UserHookPayload,
} from "./hooks";
export type {
  AuthActor,
  AuthCredentialKind,
  AuthCredentialSource,
  AuthPrincipal,
  AuthStrategyName,
  IssuedAuthCredential,
  RequestAuthFailureReason,
  ResolveRequestAuthResult,
  ResolveRequestCredentialResult,
  ResolvedRequestCredential,
  ValidatedCredential,
} from "./auth/types";
export { toAuthActor } from "./auth/actor";
export {
  getRequestAuth,
  parseBearerToken,
  resolveRequestCredential,
  resolveRequestCredentialCandidates,
} from "./auth/request-auth";
export {
  resolveAccessTokenConfig,
  verifySessionAccessToken,
  verifySessionAccessTokenDetailed,
  type ResolvedSessionAccessTokenConfig,
  type SessionAccessTokenConfig,
  type VerifySessionAccessTokenResult,
} from "./auth/session-access-token";
export {
  clearAuthSessionCache,
  DEFAULT_AUTH_SESSION_CACHE_STORAGE_KEY,
  DEFAULT_AUTH_SESSION_CACHE_TTL_SECONDS,
  isAuthSessionCacheFresh,
  readAuthSessionCache,
  writeAuthSessionCache,
} from "./client/session-cache";
export type { AuthSessionCache, AuthSessionCacheOptions } from "./client/session-cache";
export type {
  AuthEmailVerificationConfig,
  AuthEmailVerificationPolicyUser,
} from "./email-verification-policy";
export type { UserSummary } from "./types";
export type { VerifyUserEmailInput, VerifyUserEmailResult } from "./user/user-actions";
export type {
  AnyOAuthProvider,
  AuthOAuthConfig,
  OAuthProvider,
  OAuth2Tokens,
  OAuth2UserInfo,
} from "./oauth/types";
export type { GithubOAuthClient } from "./oauth/providers/github/client";
export type { GithubEmail, GithubProfile } from "./oauth/providers/github/github";
export { createGithubOAuthClient, github } from "./oauth/providers/github/github";
export type {
  AuthMeResponse,
  AutoCreateOrganizationConfig,
  DefaultOrganizationRole,
  Organization,
  OrganizationConfig,
  OrganizationHookPayload,
  OrganizationHooks,
  OrganizationInvitation,
  OrganizationInvitationSummary,
  OrganizationInvitationHookPayload,
  OrganizationInvitationStatus,
  OrganizationMember,
  OrganizationMemberSummary,
  OrganizationMemberHookPayload,
  OrganizationRoleName,
} from "./organization/types";
export type { AuthDefaultOrganizationMeLike as AuthMeLike, DefaultOrganizationResolutionStatus };
export type DefaultOrganizationEntry<TMe extends AuthDefaultOrganizationMeLike = AuthMeData> =
  AuthDefaultOrganizationEntry<TMe>;
export type DefaultOrganizationResolution<TMe extends AuthDefaultOrganizationMeLike = AuthMeData> =
  AuthDefaultOrganizationResolution<TMe>;
export type DefaultOrganizationPreferenceStore<
  TMe extends AuthDefaultOrganizationMeLike = AuthMeData,
> = import("./client/default-organization").DefaultOrganizationPreferenceStore<TMe>;
export {
  clearDefaultOrganizationId,
  DEFAULT_ORGANIZATION_CHANGE_EVENT,
  DEFAULT_ORGANIZATION_STORAGE_KEY,
  findOrganizationEntry,
  getDefaultOrganizationChangeEventName,
  getDefaultOrganizationStorageKey,
  NO_ORGANIZATIONS_ERROR_MESSAGE,
  readDefaultOrganizationId,
  resolveDefaultOrganization,
  setDefaultOrganizationForMe,
  subscribeToDefaultOrganizationPreference,
  syncDefaultOrganizationPreference,
  writeDefaultOrganizationId,
};

export type { Role };
