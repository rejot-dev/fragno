import { defineFragment, instantiate } from "@fragno-dev/core";
import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { withDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { authSchema } from "./schema";
import { createUserServices, userActionsRoutesFactory } from "./user/user-actions";
import { createSessionServices, sessionRoutesFactory } from "./session/session";
import { createActiveOrganizationServices } from "./organization/active-organization";
import { createOrganizationInvitationServices } from "./organization/invitation-services";
import { createOrganizationMemberServices } from "./organization/member-services";
import { createOrganizationServices } from "./organization/organization-services";
import { organizationRoutesFactory } from "./organization/routes";
import { createOAuthServices } from "./oauth/oauth-services";
import { oauthRoutesFactory } from "./oauth/routes";
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
import { serializeSessionSeedForQuery } from "./session/session-seed";
import type {
  AuthHooks,
  AuthHooksMap,
  BeforeCreateUserHook,
  InvitationExpiredHookPayload,
  SessionHookPayload,
  UserHookPayload,
} from "./hooks";
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
import {
  createUserOverviewServices,
  userOverviewRoutesFactory,
  type GetUsersParams,
  type UserResult,
  type SortField,
  type SortOrder,
} from "./user/user-overview";
import type { CookieOptions } from "./utils/cookie";
import type { Role } from "./types";
import type { AuthOAuthConfig } from "./oauth/types";

export interface AuthConfig<TRole extends string = DefaultOrganizationRole> {
  cookieOptions?: CookieOptions;
  hooks?: AuthHooks;
  beforeCreateUser?: BeforeCreateUserHook;
  organizations?: OrganizationConfig<TRole> | false;
  emailAndPassword?: {
    enabled?: boolean;
  };
  oauth?: AuthOAuthConfig;
}

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

    const baseHooks = {
      onUserCreated: defineHook<UserHookPayload>(async function (payload) {
        await authHooks?.onUserCreated?.(payload);
      }),
      onUserRoleUpdated: defineHook<UserHookPayload>(async function (payload) {
        await authHooks?.onUserRoleUpdated?.(payload);
      }),
      onUserPasswordChanged: defineHook<UserHookPayload>(async function (payload) {
        await authHooks?.onUserPasswordChanged?.(payload);
      }),
      onSessionCreated: defineHook<SessionHookPayload>(async function (payload) {
        await authHooks?.onSessionCreated?.(payload);
      }),
      onSessionInvalidated: defineHook<SessionHookPayload>(async function (payload) {
        await authHooks?.onSessionInvalidated?.(payload);
      }),
    };

    return {
      ...baseHooks,
      onOrganizationCreated: defineHook<OrganizationHookPayload>(async function (payload) {
        await organizationHooks?.onOrganizationCreated?.(payload);
      }),
      onOrganizationUpdated: defineHook<OrganizationHookPayload>(async function (payload) {
        await organizationHooks?.onOrganizationUpdated?.(payload);
      }),
      onOrganizationDeleted: defineHook<OrganizationHookPayload>(async function (payload) {
        await organizationHooks?.onOrganizationDeleted?.(payload);
      }),
      onMemberAdded: defineHook<OrganizationMemberHookPayload<string>>(async function (payload) {
        await organizationHooks?.onMemberAdded?.(payload);
      }),
      onMemberRemoved: defineHook<OrganizationMemberHookPayload<string>>(async function (payload) {
        await organizationHooks?.onMemberRemoved?.(payload);
      }),
      onMemberRolesUpdated: defineHook<OrganizationMemberHookPayload<string>>(
        async function (payload) {
          await organizationHooks?.onMemberRolesUpdated?.(payload);
        },
      ),
      onInvitationCreated: defineHook<OrganizationInvitationHookPayload<string>>(
        async function (payload) {
          await organizationHooks?.onInvitationCreated?.(payload);
        },
      ),
      onInvitationAccepted: defineHook<OrganizationInvitationHookPayload<string>>(
        async function (payload) {
          await organizationHooks?.onInvitationAccepted?.(payload);
        },
      ),
      onInvitationRejected: defineHook<OrganizationInvitationHookPayload<string>>(
        async function (payload) {
          await organizationHooks?.onInvitationRejected?.(payload);
        },
      ),
      onInvitationCanceled: defineHook<OrganizationInvitationHookPayload<string>>(
        async function (payload) {
          await organizationHooks?.onInvitationCanceled?.(payload);
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
                .join((j) =>
                  j.organizationInvitationOrganization((org) =>
                    org.join((j) => j.organizationCreator()),
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
          await organizationHooks?.onInvitationExpired?.({
            organization: result.organization,
            invitation: result.invitation,
            actor: null,
          });
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
      ...createUserServices(autoCreateOptions, config.beforeCreateUser),
      ...createSessionServices(config.cookieOptions),
      ...createUserOverviewServices(),
      ...createOrganizationServices({
        organizationConfig: organizationConfigResolved,
      }),
      ...createOrganizationMemberServices({
        organizationConfig: organizationConfigResolved,
      }),
      ...createOrganizationInvitationServices({
        organizationConfig: organizationConfigResolved,
      }),
      ...createActiveOrganizationServices(),
      ...createOAuthServices({
        oauth: config.oauth,
        autoCreateOptions,
        beforeCreateUser: config.beforeCreateUser,
      }),
    });
  })
  .build();

export type AuthFragment = typeof authFragmentDefinition;

export function createAuthFragment(
  config: AuthConfig = {},
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
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
}

export function createAuthFragmentClients(fragnoConfig?: FragnoPublicClientConfig) {
  // Note: Cookies are automatically sent for same-origin requests by the browser.
  // For cross-origin requests, you may need to configure CORS headers on the server.
  const config = { ...fragnoConfig };

  const b = createClientBuilder(
    authFragmentDefinition,
    config,
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
  const readRawMe = async (params?: { sessionId?: string }) => {
    if (params?.sessionId) {
      return useMe.query({ query: { sessionId: params.sessionId } });
    }

    return useMe.query();
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
        session,
        rememberMe: _rememberMe,
      }: {
        email: string;
        password: string;
        session?: {
          activeOrganizationId?: string;
        };
        rememberMe?: boolean;
      }) => {
        // Note: rememberMe is accepted but not yet implemented on the backend
        return useSignIn.mutateQuery({
          body: {
            email,
            password,
            session,
          },
        });
      },
    },

    signUp: {
      email: async ({ email, password }: { email: string; password: string }) => {
        return useSignUp.mutateQuery({
          body: {
            email,
            password,
          },
        });
      },
    },

    signOut: (params?: { sessionId?: string }) => {
      return useSignOut.mutateQuery({
        body: params?.sessionId ? { sessionId: params.sessionId } : {},
      });
    },

    me: defaultOrganizationPreference.me,

    defaultOrganization: defaultOrganizationPreference.defaultOrganization,

    oauth: {
      getAuthorizationUrl: async (params: {
        provider: string;
        returnTo?: string;
        link?: boolean;
        sessionId?: string;
        session?: {
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
            sessionId: params.sessionId,
            session: serializeSessionSeedForQuery(params.session),
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
        return useOAuthCallback.query({
          path: { provider: params.provider },
          query: {
            code: params.code,
            state: params.state,
            requestSignUp: params.requestSignUp ? "true" : undefined,
          },
        });
      },
    },
  };
}

export type { FragnoRouteConfig } from "@fragno-dev/core/api";
export type { GetUsersParams, UserResult, SortField, SortOrder };
export type AuthMeData = Awaited<ReturnType<ReturnType<typeof createAuthFragmentClients>["me"]>>;
export type {
  AuthHooks,
  BeforeCreateUserHook,
  BeforeCreateUserPayload,
  InvitationExpiredHookPayload,
  SessionHookPayload,
  UserHookPayload,
  SessionSummary,
} from "./hooks";
export type { UserSummary } from "./types";
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
