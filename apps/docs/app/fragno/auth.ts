import { createAuthFragment, github, type AuthOAuthConfig } from "@fragno-dev/auth";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

export type AuthInit =
  | {
      type: "dry-run";
    }
  | {
      type: "live";
      env: CloudflareEnv;
      state: DurableObjectState;
    };

type AuthServerOptions = {
  baseUrl?: string;
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
      organizations: false,
      oauth: oauthConfig,
    },
    { databaseAdapter: createAdapter(init.type === "live" ? init.state : undefined) },
  );
}

export type AuthFragment = ReturnType<typeof createAuthServer>;

export const fragment = createAuthServer({ type: "dry-run" });
