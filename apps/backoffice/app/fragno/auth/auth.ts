import { InMemoryAdapter } from "@fragno-dev/db/adapters/in-memory";
import z from "zod";

import {
  createAuthFragment,
  github,
  type AuthEmailVerificationConfig,
  type AuthHooks,
  type AuthOAuthConfig,
  type BeforeCreateUserHook,
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
  beforeCreateUser?: BeforeCreateUserHook;
  emailVerification?: AuthEmailVerificationConfig;
  authHooks?: AuthHooks;
  organizationHooks?: OrganizationHooks;
};

export const ACCESS_TOKEN_ISSUER = "fragno-backoffice-auth";
export const ACCESS_TOKEN_AUDIENCE = "fragno-backoffice";
const DEV_ACCESS_TOKEN_SECRET = "fragno-backoffice-development-access-token-secret";

export const backofficeAccessTokenContextSchema = z.object({
  organizationIds: z.array(z.string()),
});

export type BackofficeAccessTokenContext = z.infer<typeof backofficeAccessTokenContextSchema>;

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

export const resolveLiveAccessTokenSecret = (env: CloudflareEnv, isDev: boolean): string => {
  const configuredSecret = env.AUTH_ACCESS_TOKEN_SECRET?.trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  if (isDev) {
    return DEV_ACCESS_TOKEN_SECRET;
  }

  throw new Error("AUTH_ACCESS_TOKEN_SECRET must be configured for backoffice auth access tokens.");
};

export const resolveAccessTokenSecret = (init: AuthInit, isDev: boolean): string => {
  if (init.type === "dry-run") {
    return DEV_ACCESS_TOKEN_SECRET;
  }

  return resolveLiveAccessTokenSecret(init.env, isDev);
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
  const accessTokenSecret = resolveAccessTokenSecret(init, isDev);

  return createAuthFragment(
    {
      authentication: {
        accessTokens: {
          enabled: true,
          issuer: ACCESS_TOKEN_ISSUER,
          audience: ACCESS_TOKEN_AUDIENCE,
          secret: accessTokenSecret,
          expiresInSeconds: 15 * 60,
          context: {
            schema: backofficeAccessTokenContextSchema,
            project: ({ snapshot }) => ({
              organizationIds: snapshot.organizationIds,
            }),
          },
        },
      },
      cookieOptions: {
        sameSite: "Lax",
        secure: !isDev,
        path: "/",
      },
      hooks: options.authHooks,
      beforeCreateUser: options.beforeCreateUser,
      emailVerification: options.emailVerification,
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
