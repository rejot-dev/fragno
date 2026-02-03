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

export const authFragmentDefinition = defineFragment<AuthConfig>("simple-auth")
  .extend(withDatabase(authSchema, "simple-auth-db"))
  .providesBaseService(({ deps, config }) => {
    const userServices = createUserServices(deps.db);
    const sessionServices = createSessionServices(deps.db, config.cookieOptions);
    const userOverviewServices = createUserOverviewServices(deps.db);

    return {
      ...userServices,
      ...sessionServices,
      ...userOverviewServices,
    };
  })
  .build();

export type AuthFragment = typeof authFragmentDefinition;

export function createAuthFragment(
  config: AuthConfig = {},
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  return instantiate(authFragmentDefinition)
    .withConfig(config)
    .withOptions(fragnoConfig)
    .withRoutes([userActionsRoutesFactory, sessionRoutesFactory, userOverviewRoutesFactory])
    .build();
}

export function createAuthFragmentClients(fragnoConfig?: FragnoPublicClientConfig) {
  // Note: Cookies are automatically sent for same-origin requests by the browser.
  // For cross-origin requests, you may need to configure CORS headers on the server.
  const config = fragnoConfig || {};

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

  const { fetcher, defaultOptions } = b.getFetcher();

  const useMe = b.createHook("/me");
  const useSignOut = b.createMutator("POST", "/sign-out");
  const useUsers = b.createHook("/users");
  const useUpdateUserRole = b.createMutator("PATCH", "/users/:userId/role");
  const useChangePassword = b.createMutator("POST", "/change-password");

  return {
    // Reactive hooks - Auth
    useSignUp: b.createMutator("POST", "/sign-up"),
    useSignIn: b.createMutator("POST", "/sign-in"),
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
        const response = await fetcher("/sign-in", {
          ...defaultOptions,
          method: "POST",
          body: JSON.stringify({ email, password }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.message || "Sign in failed");
        }

        return response.json() as Promise<{
          sessionId: string;
          userId: string;
          email: string;
          role: Role;
        }>;
      },
    },

    signUp: {
      email: async ({ email, password }: { email: string; password: string }) => {
        const response = await fetcher("/sign-up", {
          ...defaultOptions,
          method: "POST",
          body: JSON.stringify({ email, password }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.message || "Sign up failed");
        }

        return response.json() as Promise<{
          sessionId: string;
          userId: string;
          email: string;
          role: Role;
        }>;
      },
    },

    signOut: () => {
      return useSignOut.mutateQuery({ body: { sessionId: undefined } });
    },

    // signOut: async () => {
    //   const response = await fetcher("/sign-out", {
    //     ...defaultOptions,
    //     method: "POST",
    //     body: JSON.stringify({}),
    //   });

    //   if (!response.ok) {
    //     const error = await response.json();
    //     throw new Error(error.message || "Sign out failed");
    //   }

    //   return response.json() as Promise<{
    //     success: boolean;
    //   }>;
    // },

    me: async () => {
      const response = await fetcher("/me", {
        ...defaultOptions,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Me failed");
      }
    },
  };
}

export type { FragnoRouteConfig } from "@fragno-dev/core/api";
export type { GetUsersParams, UserResult, SortField, SortOrder };

export type Role = "user" | "admin";
