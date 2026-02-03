import { defineFragment, instantiate } from "@fragno-dev/core";
import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { withDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { authSchema } from "./schema";
import { createUserServices, userActionsRoutesFactory } from "./user/user-actions";
import { createSessionServices, sessionRoutesFactory } from "./session/session";
import {
  createUserOverviewServices,
  userOverviewRoutesFactory,
  type GetUsersParams,
  type UserResult,
  type SortField,
  type SortOrder,
} from "./user/user-overview";
import type { CookieOptions } from "./utils/cookie";

export interface AuthConfig {
  sendEmail?: (params: { to: string; subject: string; body: string }) => Promise<void>;
  cookieOptions?: CookieOptions;
}

export const authFragmentDefinition = defineFragment<AuthConfig>("auth")
  .extend(withDatabase(authSchema))
  .providesBaseService(({ defineService, config }) => {
    return defineService({
      ...createUserServices(),
      ...createSessionServices(config.cookieOptions),
      ...createUserOverviewServices(),
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
    .withRoutes([userActionsRoutesFactory, sessionRoutesFactory, userOverviewRoutesFactory])
    .build();
}

export function createAuthFragmentClients(fragnoConfig?: FragnoPublicClientConfig) {
  // Note: Cookies are automatically sent for same-origin requests by the browser.
  // For cross-origin requests, you may need to configure CORS headers on the server.
  const config = { ...fragnoConfig };

  const b = createClientBuilder(
    authFragmentDefinition,
    config,
    [userActionsRoutesFactory, sessionRoutesFactory, userOverviewRoutesFactory],
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

  return {
    // Reactive hooks - Auth
    useSignUp,
    useSignIn,
    useSignOut,
    useMe,
    useUsers,
    useUpdateUserRole,
    useChangePassword,

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

export type Role = "user" | "admin";
