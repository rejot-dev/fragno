import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { betterAuth } from "better-auth";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { genericOAuth } from "better-auth/plugins";
import { DurableObject } from "cloudflare:workers";
import { Kysely } from "kysely";
import { z } from "zod";

import { applyMigrations } from "../migrations";
import betterAuthMigration from "./migrations/0001-better-auth.sql?raw";
import organizationsMigration from "./migrations/0002-organizations.sql?raw";
import backofficeOwnerMigration from "./migrations/0003-backoffice-owner.sql?raw";
import dropOrganizationsMigration from "./migrations/0004-drop-organizations.sql?raw";

const migrations = [
  betterAuthMigration,
  organizationsMigration,
  backofficeOwnerMigration,
  dropOrganizationsMigration,
];

const BACKOFFICE_PROVIDER_ID = "backoffice";
// Refresh slightly early so a token does not expire between this check and its use.
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5_000;
// OAuth errors meaning the grant itself is gone (revoked, expired, or consent withdrawn).
const REVOKED_GRANT_ERRORS = new Set(["invalid_grant", "access_denied"]);

/** The user's Backoffice account's OAuth state, as seen by Bookkeeping's server. */
export type BackofficeAccessToken =
  | { status: "authorized"; accessToken: string }
  | { status: "reauthorization-required" }
  | { status: "backoffice-unavailable" };

/** A signed-in person, with the Backoffice account they signed in with. */
export type SessionUser = {
  id: string;
  name: string;
  email: string;
  /** Their Backoffice user ID: Backoffice's member lists, roles, and invitations name this. */
  backofficeUserId: string;
};

type StoredBackofficeAccount = {
  id: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
};

/**
 * Bookkeeping's accounts and sessions in one SQLite Durable Object; every account is a Backoffice
 * account. Methods other than `fetch` are server-only RPC; browsers reach Better Auth through
 * `fetch`.
 */
export class Auth extends DurableObject<CloudflareEnv> {
  private readonly auth;
  // Backoffice may rotate refresh tokens, so concurrent refreshes of one account must share a call.
  private readonly refreshes = new Map<string, Promise<BackofficeAccessToken>>();

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
      // Every account is a Backoffice account: people sign up and sign in through Backoffice.
      emailAndPassword: { enabled: false },
      // Provider tokens are used only by Bookkeeping's server; never return them to browsers.
      account: { encryptOAuthTokens: true },
      disabledPaths: ["/get-access-token", "/refresh-token"],
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
              // `backoffice` lets the server exchange this token for organization-bound app credentials.
              scopes: ["openid", "profile", "email", "offline_access", "backoffice"],
              // Backoffice only accepts access tokens issued for its own resource.
              authorizationUrlParams: { resource: backofficeURL },
              tokenUrlParams: { resource: backofficeURL },
              refreshTokenParams: { resource: backofficeURL },
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
    // This dialect cannot introspect tables; apply versioned SQL migrations instead.
    void ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx, migrations);
    });
  }

  fetch(request: Request) {
    return this.auth.handler(request);
  }

  /** The session's user, or null without a valid session. */
  async getSessionUser(cookie: string): Promise<SessionUser | null> {
    const session = await this.auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session) {
      return null;
    }
    const account = await this.findBackofficeAccount(session.user.id);
    return {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      backofficeUserId: account.accountId,
    };
  }

  /**
   * The names Bookkeeping's users gave it, by Backoffice user ID. Backoffice's member lists have
   * no name for people who signed up with an email code. Anyone who never signed in to
   * Bookkeeping, or has not given a name yet, is absent.
   */
  findNames(backofficeUserIds: string[]): Record<string, string> {
    // One JSON parameter: Durable Object SQLite binds at most 100 values per statement.
    const rows = this.ctx.storage.sql
      .exec<{ accountId: string; name: string }>(
        `SELECT a."accountId", u."name" FROM "account" a JOIN "user" u ON u."id" = a."userId"
         WHERE a."providerId" = ? AND a."accountId" IN (SELECT "value" FROM json_each(?))`,
        BACKOFFICE_PROVIDER_ID,
        JSON.stringify(backofficeUserIds),
      )
      .toArray();
    return Object.fromEntries(
      rows.filter(({ name }) => name.trim() !== "").map(({ accountId, name }) => [accountId, name]),
    );
  }

  /** Bookkeeping keeps the name people give it; Backoffice's sign-up asks only for an email. */
  async setUserName(input: { userId: string; name: string }): Promise<void> {
    const context = await this.auth.$context;
    await context.internalAdapter.updateUser(input.userId, { name: input.name });
  }

  // Users sign up and sign in only through Backoffice, so each has its account.
  private async findBackofficeAccount(userId: string) {
    const context = await this.auth.$context;
    const account = (await context.internalAdapter.findAccounts(userId)).find(
      ({ providerId }) => providerId === BACKOFFICE_PROVIDER_ID,
    );
    if (!account) {
      throw new Error(`Bookkeeping user ${userId} has no Backoffice account.`);
    }
    return account;
  }

  /**
   * Returns a valid Backoffice access token for the session's Backoffice account, refreshing it if
   * needed. Bookkeeping refreshes itself because Better Auth reports every refresh failure the same
   * way, which would make a Backoffice outage look like revoked authorization.
   */
  async getBackofficeAccessToken(cookie: string): Promise<BackofficeAccessToken> {
    const session = await this.auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session) {
      throw new Error("Backoffice access requires a signed-in Bookkeeping session.");
    }
    const account = await this.findBackofficeAccount(session.user.id);
    const expiresAt = account.accessTokenExpiresAt
      ? new Date(account.accessTokenExpiresAt).getTime()
      : null;
    if (expiresAt === null || expiresAt - Date.now() > ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      const accessToken = await this.readStoredToken(account.accessToken);
      if (accessToken) {
        return { status: "authorized", accessToken };
      }
    }
    let refresh = this.refreshes.get(account.id);
    if (!refresh) {
      refresh = this.refreshBackofficeAccessToken(account).finally(() => {
        this.refreshes.delete(account.id);
      });
      this.refreshes.set(account.id, refresh);
    }
    return await refresh;
  }

  private async refreshBackofficeAccessToken(
    account: StoredBackofficeAccount,
  ): Promise<BackofficeAccessToken> {
    const refreshToken = await this.readStoredToken(account.refreshToken);
    if (!refreshToken) {
      return { status: "reauthorization-required" };
    }
    const backofficeURL = new URL(this.env.BACKOFFICE_BASE_URL).origin;
    let response: Response;
    try {
      response = await fetch(`${backofficeURL}/api/auth/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${this.env.BACKOFFICE_OAUTH_CLIENT_ID}:${this.env.BACKOFFICE_OAUTH_CLIENT_SECRET}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          resource: backofficeURL,
        }),
      });
    } catch {
      return { status: "backoffice-unavailable" };
    }
    if (response.status >= 500) {
      return { status: "backoffice-unavailable" };
    }
    if (!response.ok) {
      const failure = z
        .object({ error: z.string() })
        .safeParse(await response.json().catch(() => null));
      if (failure.success && REVOKED_GRANT_ERRORS.has(failure.data.error)) {
        return { status: "reauthorization-required" };
      }
      throw new Error(
        `Backoffice rejected Bookkeeping's token refresh (HTTP ${response.status}${failure.success ? `, ${failure.data.error}` : ""}). Check BACKOFFICE_OAUTH_CLIENT_ID and BACKOFFICE_OAUTH_CLIENT_SECRET.`,
      );
    }
    const tokens = z
      .object({
        access_token: z.string().min(1),
        expires_in: z.number().int().positive(),
        // Present only when Backoffice rotates the refresh token.
        refresh_token: z.string().min(1).optional(),
      })
      .parse(await response.json());
    const context = await this.auth.$context;
    const encrypt = async (data: string) =>
      await symmetricEncrypt({ key: context.secretConfig, data });
    await context.internalAdapter.updateAccount(account.id, {
      accessToken: await encrypt(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      ...(tokens.refresh_token ? { refreshToken: await encrypt(tokens.refresh_token) } : {}),
    });
    return { status: "authorized", accessToken: tokens.access_token };
  }

  /** Tokens that cannot be decrypted (for example, stored before encryption) need a new grant. */
  private async readStoredToken(token: string | null | undefined): Promise<string | null> {
    if (!token) {
      return null;
    }
    const context = await this.auth.$context;
    return await symmetricDecrypt({ key: context.secretConfig, data: token }).catch(() => null);
  }
}
