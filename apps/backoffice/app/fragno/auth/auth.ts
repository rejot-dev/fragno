import { InMemoryAdapter } from "@fragno-dev/db/adapters/in-memory";

import {
  createAuthFragment,
  github,
  type AuthOAuthConfig,
  type OrganizationHooks,
} from "@fragno-dev/auth";

import type { BackofficeDatabaseAdapterFactory } from "@/backoffice-runtime/database-adapters";

export type AuthInit =
  | {
      type: "dry-run";
    }
  | {
      type: "live";
      env: CloudflareEnv;
      adapters: BackofficeDatabaseAdapterFactory;
    };

type AuthServerOptions = {
  baseUrl?: string;
  organizationHooks?: OrganizationHooks;
};

const resolveBaseUrl = (baseUrl?: string) => {
  if (!baseUrl) {
    return undefined;
  }

  try {
    return new URL(baseUrl).toString();
  } catch (error) {
    throw new Error(`Auth baseUrl must be an absolute URL. Received: ${baseUrl}`, {
      cause: error,
    });
  }
};

const buildOauthConfig = (init: AuthInit, baseUrl?: string): AuthOAuthConfig | undefined => {
  if (init.type !== "live") {
    return undefined;
  }

  const { env } = init;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return undefined;
  }

  const redirectUri = baseUrl
    ? new URL("/api/auth/oauth/github/callback", baseUrl).toString()
    : undefined;

  return {
    providers: {
      github: github({
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      }),
    },
    defaultRedirectUri: redirectUri,
  };
};

export function createAuthServer(init: AuthInit, options: AuthServerOptions = {}) {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const oauthConfig = buildOauthConfig(init, baseUrl);
  const isDev = import.meta.env.MODE === "development";

  return createAuthFragment(
    {
      cookieOptions: {
        sameSite: "Lax",
        secure: !isDev,
        path: "/",
      },
      organizations: {
        autoCreateOrganization: {},
        ...(options.organizationHooks ? { hooks: options.organizationHooks } : {}),
      },
      oauth: oauthConfig,
    },
    {
      databaseAdapter:
        init.type === "live"
          ? init.adapters.createAdapter({
              kind: "auth",
            })
          : new InMemoryAdapter(),
    },
  );
}

export type AuthFragment = ReturnType<typeof createAuthServer>;

export const authFragment = createAuthServer({ type: "dry-run" });
