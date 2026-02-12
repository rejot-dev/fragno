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
import type { AuthHooks, AuthHooksMap, SessionHookPayload, UserHookPayload } from "./hooks";
import type {
  DefaultOrganizationRole,
  OrganizationConfig,
  OrganizationHookPayload,
  OrganizationHooks,
  OrganizationInvitationHookPayload,
  OrganizationMemberHookPayload,
} from "./organization/types";
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

export interface AuthConfig<TRole extends string = DefaultOrganizationRole> {
  cookieOptions?: CookieOptions;
  hooks?: AuthHooks;
  organizations?: OrganizationConfig<TRole> | false;
}

export const authFragmentDefinition = defineFragment<AuthConfig>("auth")
  .extend(withDatabase(authSchema))
  .provideHooks<AuthHooksMap>(({ defineHook, config }) => {
    const authHooks = config.hooks;
    const organizationConfig = config.organizations === false ? undefined : config.organizations;
    const organizationHooks = organizationConfig?.hooks as OrganizationHooks<string> | undefined;

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
    };
  })
  .providesBaseService(({ defineService, config }) => {
    const organizationsEnabled = config.organizations !== false;
    const organizationConfig = config.organizations === false ? undefined : config.organizations;

    return defineService({
      ...createUserServices(
        organizationsEnabled
          ? {
              autoCreateOrganization:
                organizationConfig && organizationConfig.autoCreateOrganization !== false
                  ? organizationConfig.autoCreateOrganization
                  : undefined,
              creatorRoles: organizationConfig?.creatorRoles,
              organizationHooksEnabled: organizationsEnabled,
            }
          : undefined,
      ),
      ...createSessionServices(config.cookieOptions),
      ...createUserOverviewServices(),
      ...createOrganizationServices({ hooksEnabled: organizationsEnabled }),
      ...createOrganizationMemberServices({ hooksEnabled: organizationsEnabled }),
      ...createOrganizationInvitationServices({ hooksEnabled: organizationsEnabled }),
      ...createActiveOrganizationServices(),
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

  const organizationsEnabled = config.organizations !== false;

  return instantiate(authFragmentDefinition)
    .withConfig(config)
    .withOptions(options)
    .withRoutes([
      userActionsRoutesFactory,
      sessionRoutesFactory,
      userOverviewRoutesFactory,
      ...(organizationsEnabled ? [organizationRoutesFactory] : []),
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
  const useCreateOrganization = b.createMutator("POST", "/organizations");
  const useUpdateOrganization = b.createMutator("PATCH", "/organizations/:organizationId");
  const useDeleteOrganization = b.createMutator("DELETE", "/organizations/:organizationId");
  const useActiveOrganization = b.createHook("/organizations/active");
  const useSetActiveOrganization = b.createMutator("POST", "/organizations/active");
  const useOrganizationMembers = b.createHook("/organizations/:organizationId/members");
  const useAddOrganizationMember = b.createMutator(
    "POST",
    "/organizations/:organizationId/members",
  );
  const useUpdateOrganizationMemberRoles = b.createMutator(
    "PATCH",
    "/organizations/:organizationId/members/:memberId",
  );
  const useRemoveOrganizationMember = b.createMutator(
    "DELETE",
    "/organizations/:organizationId/members/:memberId",
  );
  const useOrganizationInvitations = b.createHook("/organizations/:organizationId/invitations");
  const useInviteOrganizationMember = b.createMutator(
    "POST",
    "/organizations/:organizationId/invitations",
  );
  const useRespondOrganizationInvitation = b.createMutator(
    "PATCH",
    "/organizations/invitations/:invitationId",
  );
  const useUserInvitations = b.createHook("/organizations/invitations");

  return {
    // Reactive hooks - Auth
    useSignUp,
    useSignIn,
    useSignOut,
    useMe,
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

    // Non-reactive methods
    signIn: {
      email: async ({
        email,
        password,
        rememberMe: _rememberMe,
      }: {
        email: string;
        password: string;
        rememberMe?: boolean;
      }) => {
        // Note: rememberMe is accepted but not yet implemented on the backend
        return useSignIn.mutateQuery({
          body: {
            email,
            password,
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

    me: async (params?: { sessionId?: string }) => {
      if (params?.sessionId) {
        return useMe.query({ query: { sessionId: params.sessionId } });
      }

      return useMe.query();
    },
  };
}

export type { FragnoRouteConfig } from "@fragno-dev/core/api";
export type { GetUsersParams, UserResult, SortField, SortOrder };
export type { AuthHooks, SessionHookPayload, UserHookPayload } from "./hooks";
export type {
  AuthMeResponse,
  DefaultOrganizationRole,
  Organization,
  OrganizationConfig,
  OrganizationHookPayload,
  OrganizationHooks,
  OrganizationInvitation,
  OrganizationInvitationHookPayload,
  OrganizationInvitationStatus,
  OrganizationMember,
  OrganizationMemberHookPayload,
  OrganizationRoleName,
} from "./organization/types";

export type { Role };
