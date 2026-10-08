import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { betterAuth } from "better-auth";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { genericOAuth, organization } from "better-auth/plugins";
import { DurableObject } from "cloudflare:workers";
import { Kysely } from "kysely";
import { z } from "zod";

import organizationsSchema from "./auth-schema-0002-organizations.sql?raw";
import initialSchema from "./auth-schema.sql?raw";

/** Applied in order; the stored version is the number of migrations already applied. */
const migrations = [initialSchema, organizationsSchema];

const LINK_REQUEST_LIFETIME_MS = 10 * 60 * 1000;
const BACKOFFICE_PROVIDER_ID = "backoffice";
// Refresh slightly early so a token does not expire between this check and its use.
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5_000;
// OAuth errors meaning the grant itself is gone (revoked, expired, or consent withdrawn).
const REVOKED_GRANT_ERRORS = new Set(["invalid_grant", "access_denied"]);

/** The linked Backoffice account's OAuth state, as seen by Bookkeeping's server. */
export type BackofficeAccessToken =
  | { status: "linked"; accessToken: string }
  | { status: "not-linked" }
  | { status: "reauthorization-required" }
  | { status: "backoffice-unavailable" };

export type BackofficeLinkRequest =
  | { status: "ready"; organizationId: string; organizationName: string; userId: string }
  | { status: "expired" }
  | { status: "forbidden" };

/** Resources the Backoffice organization approved, as reported when Bookkeeping claimed it. */
export type BackofficeResourceScope =
  | { kind: "organization" }
  | { kind: "projects"; projectIds: string[] };

export type BackofficeLink = {
  organizationId: string;
  backofficeOrganizationId: string;
  resourceScope: BackofficeResourceScope;
  linkedAt: string;
};

export type ActiveOrganization = {
  organization: { id: string; name: string };
  /** Owners and admins may connect and disconnect Backoffice. */
  canManage: boolean;
  userId: string;
};

type StoredBackofficeAccount = {
  id: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
};

/**
 * Bookkeeping's accounts, organizations, and Backoffice links in one SQLite Durable Object.
 * Methods other than `fetch` are server-only RPC; browsers reach Better Auth through `fetch`.
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
      emailAndPassword: { enabled: true },
      // Provider tokens are used only by Bookkeeping's server; never return them to browsers.
      account: { encryptOAuthTokens: true },
      disabledPaths: ["/get-access-token", "/refresh-token"],
      plugins: [
        organization(),
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
    // This dialect cannot introspect tables; apply versioned SQL migrations instead. Each one
    // commits atomically with its version so a failed deploy never half-applies a migration.
    void ctx.blockConcurrencyWhile(async () => {
      const applied = ctx.storage.kv.get<number>("schemaVersion") ?? 0;
      for (const [index, migration] of migrations.entries()) {
        if (index >= applied) {
          ctx.storage.transactionSync(() => {
            ctx.storage.sql.exec(migration);
            ctx.storage.kv.put("schemaVersion", index + 1);
          });
        }
      }
    });
  }

  fetch(request: Request) {
    return this.auth.handler(request);
  }

  /**
   * Returns a valid Backoffice access token for the session's own linked account, refreshing it if
   * needed. Bookkeeping refreshes itself because Better Auth reports every refresh failure the same
   * way, which would make a Backoffice outage look like revoked authorization.
   */
  async getBackofficeAccessToken(cookie: string): Promise<BackofficeAccessToken> {
    const session = await this.auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session) {
      throw new Error("Backoffice access requires a signed-in Bookkeeping session.");
    }
    const context = await this.auth.$context;
    const account = (await context.internalAdapter.findAccounts(session.user.id)).find(
      ({ providerId }) => providerId === BACKOFFICE_PROVIDER_ID,
    );
    if (!account) {
      return { status: "not-linked" };
    }
    const expiresAt = account.accessTokenExpiresAt
      ? new Date(account.accessTokenExpiresAt).getTime()
      : null;
    if (expiresAt === null || expiresAt - Date.now() > ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      const accessToken = await this.readStoredToken(account.accessToken);
      if (accessToken) {
        return { status: "linked", accessToken };
      }
    }
    let refresh = this.refreshes.get(account.id);
    if (!refresh) {
      refresh = this.refreshBackofficeAccessToken(account).finally(() =>
        this.refreshes.delete(account.id),
      );
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
    return { status: "linked", accessToken: tokens.access_token };
  }

  /** Tokens that cannot be decrypted (for example, stored before encryption) need a new grant. */
  private async readStoredToken(token: string | null | undefined): Promise<string | null> {
    if (!token) {
      return null;
    }
    const context = await this.auth.$context;
    return await symmetricDecrypt({ key: context.secretConfig, data: token }).catch(() => null);
  }

  /** Owners and admins of an organization may connect and disconnect Backoffice for it. */
  private canManageOrganization(organizationId: string, userId: string): boolean {
    const [member] = this.ctx.storage.sql
      .exec<{ role: string }>(
        `SELECT "role" FROM "member" WHERE "organizationId" = ? AND "userId" = ?`,
        organizationId,
        userId,
      )
      .toArray();
    return (
      member !== undefined &&
      member.role.split(",").some((role) => role === "owner" || role === "admin")
    );
  }

  /** The signed-in user's active organization and whether they may manage it. */
  async getActiveOrganization(cookie: string): Promise<ActiveOrganization | null> {
    const session = await this.auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session) {
      return null;
    }
    const [row] = this.ctx.storage.sql
      .exec<{ id: string; name: string }>(
        `SELECT "organization"."id", "organization"."name"
         FROM "session"
         JOIN "member" ON "member"."organizationId" = "session"."activeOrganizationId"
           AND "member"."userId" = "session"."userId"
         JOIN "organization" ON "organization"."id" = "member"."organizationId"
         WHERE "session"."id" = ?`,
        session.session.id,
      )
      .toArray();
    return row
      ? {
          organization: { id: row.id, name: row.name },
          canManage: this.canManageOrganization(row.id, session.user.id),
          userId: session.user.id,
        }
      : null;
  }

  /** Starts linking the active organization; only its owners and admins may do this. */
  async startBackofficeLink(cookie: string): Promise<{ state: string } | null> {
    const active = await this.getActiveOrganization(cookie);
    if (!active?.canManage) {
      return null;
    }
    const state = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    const now = Date.now();
    this.ctx.storage.sql.exec(`DELETE FROM "backoffice_link_request" WHERE "expiresAt" <= ?`, now);
    this.ctx.storage.sql.exec(
      `INSERT INTO "backoffice_link_request" ("state", "organizationId", "userId", "expiresAt")
       VALUES (?, ?, ?, ?)`,
      state,
      active.organization.id,
      active.userId,
      now + LINK_REQUEST_LIFETIME_MS,
    );
    return { state };
  }

  /**
   * Consumes a link request exactly once, for the same signed-in user who started it, so a
   * callback cannot be replayed or completed from another browser session. Authority is checked
   * again: the user may have lost it since starting.
   */
  async consumeBackofficeLinkRequest(
    cookie: string,
    state: string,
  ): Promise<BackofficeLinkRequest> {
    const session = await this.auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session) {
      return { status: "expired" };
    }
    const [request] = this.ctx.storage.sql
      .exec<{ organizationId: string; userId: string; expiresAt: number; name: string }>(
        `DELETE FROM "backoffice_link_request" WHERE "state" = ?
         RETURNING "organizationId", "userId", "expiresAt",
           (SELECT "name" FROM "organization" WHERE "id" = "organizationId") AS "name"`,
        state,
      )
      .toArray();
    if (!request || request.userId !== session.user.id || request.expiresAt <= Date.now()) {
      return { status: "expired" };
    }
    if (!this.canManageOrganization(request.organizationId, request.userId)) {
      return { status: "forbidden" };
    }
    return {
      status: "ready",
      organizationId: request.organizationId,
      organizationName: request.name,
      userId: request.userId,
    };
  }

  /**
   * Records the link Backoffice confirmed, if the linking user still manages the organization.
   * The check shares the write's transaction because claiming in Backoffice happens in between.
   * Backoffice is authoritative: a stale local link from another organization to the same
   * Backoffice organization is replaced.
   */
  async saveBackofficeLink(input: {
    organizationId: string;
    backofficeOrganizationId: string;
    resourceScope: BackofficeResourceScope;
    linkedByUserId: string;
  }): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      if (!this.canManageOrganization(input.organizationId, input.linkedByUserId)) {
        return false;
      }
      this.ctx.storage.sql.exec(
        `DELETE FROM "backoffice_link" WHERE "organizationId" = ? OR "backofficeOrganizationId" = ?`,
        input.organizationId,
        input.backofficeOrganizationId,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO "backoffice_link"
           ("organizationId", "backofficeOrganizationId", "resourceScope", "linkedByUserId", "linkedAt")
         VALUES (?, ?, ?, ?, ?)`,
        input.organizationId,
        input.backofficeOrganizationId,
        JSON.stringify(input.resourceScope),
        input.linkedByUserId,
        Date.now(),
      );
      return true;
    });
  }

  async getBackofficeLink(organizationId: string): Promise<BackofficeLink | null> {
    const [row] = this.ctx.storage.sql
      .exec<{ backofficeOrganizationId: string; resourceScope: string; linkedAt: number }>(
        `SELECT "backofficeOrganizationId", "resourceScope", "linkedAt"
         FROM "backoffice_link" WHERE "organizationId" = ?`,
        organizationId,
      )
      .toArray();
    return row
      ? {
          organizationId,
          backofficeOrganizationId: row.backofficeOrganizationId,
          // Written only by saveBackofficeLink from a validated Backoffice response.
          resourceScope: JSON.parse(row.resourceScope) as BackofficeResourceScope,
          linkedAt: new Date(row.linkedAt).toISOString(),
        }
      : null;
  }

  /** Forgets the active organization's link; uninstalling remains a Backoffice decision. */
  async removeBackofficeLink(cookie: string): Promise<boolean> {
    const active = await this.getActiveOrganization(cookie);
    if (!active?.canManage) {
      return false;
    }
    this.ctx.storage.sql.exec(
      `DELETE FROM "backoffice_link" WHERE "organizationId" = ?`,
      active.organization.id,
    );
    return true;
  }
}
