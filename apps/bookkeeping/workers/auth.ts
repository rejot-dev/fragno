import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { DurableObject } from "cloudflare:workers";
import { Kysely } from "kysely";

import schema from "./auth-schema.sql?raw";

export class Auth extends DurableObject<CloudflareEnv> {
  private readonly auth;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    const database = new Kysely<Record<string, never>>({
      dialect: new DurableObjectDialect({ ctx, queryInstrumentation: null }),
    });
    const backofficeURL = new URL(env.BACKOFFICE_BASE_URL).origin;
    const options = {
      database: { db: database, type: "sqlite" as const, transaction: true },
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BOOKKEEPING_BASE_URL,
      emailAndPassword: { enabled: true },
      plugins: [
        genericOAuth({
          config: [
            {
              providerId: "backoffice",
              clientId: env.BACKOFFICE_OAUTH_CLIENT_ID,
              clientSecret: env.BACKOFFICE_OAUTH_CLIENT_SECRET,
              accountIssuer: backofficeURL,
              accountSubject: ({ profile }) => profile.sub ?? "",
              authorizationUrl: `${backofficeURL}/api/auth/oauth2/authorize`,
              tokenUrl: `${backofficeURL}/api/auth/oauth2/token`,
              userInfoUrl: `${backofficeURL}/api/auth/oauth2/userinfo`,
              tokenEndpointAuth: { method: "client_secret_basic" },
              scopes: ["openid", "profile", "email"],
              pkce: true,
              // Backoffice has no discovery document. Use authenticated userinfo, never decoded ID-token claims.
              getUserInfo: async function getBackofficeUserInfo(tokens) {
                const response = await fetch(`${backofficeURL}/api/auth/oauth2/userinfo`, {
                  headers: { Authorization: `Bearer ${tokens.accessToken}` },
                });
                if (response.status === 401 || response.status === 403) {
                  return null;
                }
                if (!response.ok) {
                  throw new Error(
                    `Backoffice userinfo request to ${backofficeURL}/api/auth/oauth2/userinfo failed: HTTP ${response.status} ${response.statusText}`,
                  );
                }
                const profile = (await response.json()) as {
                  sub: string;
                  name: string;
                  email: string;
                  email_verified: boolean;
                  picture: string | null;
                };
                return {
                  sub: profile.sub,
                  name: profile.name,
                  email: profile.email,
                  emailVerified: profile.email_verified,
                  image: profile.picture ?? undefined,
                };
              },
            },
          ],
        }),
      ],
    };
    this.auth = betterAuth(options);
    // This dialect cannot introspect tables; apply the generated default schema once instead.
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.get("schemaVersion")) === undefined) {
        ctx.storage.transactionSync(() => ctx.storage.sql.exec(schema));
        await ctx.storage.put("schemaVersion", 1);
      }
    });
  }

  fetch(request: Request) {
    return this.auth.handler(request);
  }
}
