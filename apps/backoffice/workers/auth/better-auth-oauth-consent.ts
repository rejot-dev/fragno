import { defineRequestState } from "@better-auth/core/context";
import { decodeBasicCredentials } from "@better-auth/core/oauth2";
import type { AuthContext, BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { z } from "zod";

import { Cursor, decodeCursor } from "@fragno-dev/db";

import {
  extendOAuthProvider,
  type OAuthClaimExtensionInput,
  type OAuthOptions,
} from "@better-auth/oauth-provider";

const oauthTokenConsentRequest = defineRequestState<{
  adapter: AuthContext["adapter"];
  claimedClientId: string;
} | null>(() => null);

import {
  backofficeOAuthConsentRequestSchema,
  backofficeOAuthConsentListInputSchema,
  backofficeOAuthConsentRevokeInputSchema,
  type BackofficeOAuthConsentPage,
} from "@/fragno/auth/oauth-consent";

type StoredOAuthConsent = {
  id: string;
  clientId: string;
  userId: string;
  scopes: string[];
  resources: string[] | null;
  requestedUserInfoClaims: string[] | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Live consent is required even when the OAuth proof is a self-contained JWT. */
export async function requireBackofficeOAuthConsent(
  adapter: AuthContext["adapter"],
  input: { userId: string; clientId: string; scopes: string[]; requestedUserInfoClaims: string[] },
): Promise<void> {
  const consent = await adapter.findOne<
    Pick<StoredOAuthConsent, "scopes" | "requestedUserInfoClaims">
  >({
    model: "oauthConsent",
    select: ["scopes", "requestedUserInfoClaims"],
    where: [
      { field: "userId", value: input.userId },
      { field: "clientId", value: input.clientId },
    ],
  });
  if (
    !consent ||
    !input.scopes.every((scope) => consent.scopes.includes(scope)) ||
    !input.requestedUserInfoClaims.every((claim) =>
      (consent.requestedUserInfoClaims ?? []).includes(claim),
    )
  ) {
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      message: "OAuth consent is missing or has been revoked. Authorize this client again.",
    });
  }
}

async function enforceOAuthTokenConsent(input: OAuthClaimExtensionInput) {
  if (input.user) {
    await requireBackofficeOAuthConsent(input.ctx.context.adapter, {
      userId: input.user.id,
      clientId: input.client.clientId,
      scopes: input.scopes,
      requestedUserInfoClaims: [],
    });
  }
  return {};
}

/** Runs before all user token persistence, including opaque grants without openid. */
export async function enforceBackofficeOAuthTokenResponseConsent(
  input: Parameters<NonNullable<OAuthOptions<string[]>["customTokenResponseFields"]>>[0],
): Promise<Record<string, unknown>> {
  if (!input.user) {
    return {};
  }
  const request = await oauthTokenConsentRequest.get();
  if (!request) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_client",
      error_description: "OAuth client identity is required for consent enforcement.",
    });
  }
  // The provider calls this only after authenticating the client, rejecting conflicting IDs,
  // and validating the grant. Its verified user and scopes are authoritative here.
  await requireBackofficeOAuthConsent(request.adapter, {
    userId: input.user.id,
    clientId: request.claimedClientId,
    scopes: input.scopes,
    requestedUserInfoClaims: [],
  });
  return {};
}

/** Lists one user's OAuth authorizations; cursors are bound to that user and the page size. */
export async function listBackofficeOAuthConsentPage(
  adapter: AuthContext["adapter"],
  input: { userId: string; pageSize: number; cursor: string | null },
): Promise<BackofficeOAuthConsentPage> {
  const { userId, pageSize, cursor } = input;
  let afterId: string | null = null;
  if (cursor !== null) {
    try {
      const decoded = decodeCursor(cursor);
      if (
        decoded.indexName !== "oauthConsent.id" ||
        decoded.orderDirection !== "asc" ||
        decoded.pageSize !== pageSize ||
        decoded.indexValues.userId !== userId ||
        typeof decoded.indexValues.id !== "string" ||
        !decoded.indexValues.id
      ) {
        throw new Error("Invalid consent cursor");
      }
      afterId = decoded.indexValues.id;
    } catch {
      throw new APIError("BAD_REQUEST", {
        message: "OAuth consent listing cursor is invalid.",
      });
    }
  }
  const rows = await adapter.findMany<StoredOAuthConsent>({
    model: "oauthConsent",
    select: [
      "id",
      "clientId",
      "userId",
      "scopes",
      "resources",
      "requestedUserInfoClaims",
      "createdAt",
      "updatedAt",
    ],
    where: [
      { field: "userId", value: userId },
      ...(afterId === null ? [] : [{ field: "id", operator: "gt" as const, value: afterId }]),
    ],
    sortBy: { field: "id", direction: "asc" },
    limit: pageSize + 1,
  });
  const hasNextPage = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const clients =
    page.length === 0
      ? []
      : await adapter.findMany<{ clientId: string; name: string | null }>({
          model: "oauthClient",
          select: ["clientId", "name"],
          where: [
            {
              field: "clientId",
              operator: "in",
              value: page.map((consent) => consent.clientId),
            },
          ],
        });
  const names = new Map(clients.map((client) => [client.clientId, client.name]));
  return {
    consents: page.map((consent) => ({
      id: consent.id,
      clientId: consent.clientId,
      clientName: names.get(consent.clientId) ?? consent.clientId,
      scopes: consent.scopes,
      resources: consent.resources ?? [],
      requestedUserInfoClaims: consent.requestedUserInfoClaims ?? [],
      createdAt: consent.createdAt.toISOString(),
      updatedAt: consent.updatedAt.toISOString(),
    })),
    hasNextPage,
    nextCursor: hasNextPage
      ? new Cursor({
          indexName: "oauthConsent.id",
          orderDirection: "asc",
          pageSize,
          indexValues: { id: page[page.length - 1].id, userId },
        }).encode()
      : null,
  };
}

/** Better Auth owns consent storage; device approval is recorded in the same provider model. */
export function createBackofficeOAuthConsentPlugin(): BetterAuthPlugin {
  return {
    id: "fragno-backoffice-oauth-consent",
    init(context) {
      extendOAuthProvider(context, {
        claims: {
          accessToken: enforceOAuthTokenConsent,
          idToken: enforceOAuthTokenConsent,
          async userInfo(input) {
            if (!input.client) {
              throw new APIError("UNAUTHORIZED", { message: "OAuth client is unavailable." });
            }
            await requireBackofficeOAuthConsent(input.ctx.context.adapter, {
              userId: input.user.id,
              clientId: input.client.clientId,
              scopes: input.scopes,
              requestedUserInfoClaims: input.requestedClaims,
            });
            return {};
          },
        },
      });
    },
    hooks: {
      before: [
        {
          matcher(context) {
            return context.path === "/oauth2/token";
          },
          handler: createAuthMiddleware(async function bindOAuthTokenConsentRequest(context) {
            const authorization = context.headers?.get("authorization");
            const clientId =
              authorization && /^Basic\s/i.test(authorization)
                ? decodeBasicCredentials(authorization).clientId
                : typeof context.body?.client_id === "string"
                  ? context.body.client_id
                  : null;
            await oauthTokenConsentRequest.set(
              clientId === null
                ? null
                : { adapter: context.context.adapter, claimedClientId: clientId },
            );
          }),
        },
        {
          matcher(context) {
            return [
              "/oauth2/consent",
              "/oauth2/update-consent",
              "/oauth2/delete-consent",
              "/device/approve",
              "/device/deny",
              "/backoffice/oauth/revoke-consent",
            ].some((path) => path === context.path);
          },
          handler: createAuthMiddleware(async function requireSameOriginOAuthDecision(context) {
            if (context.headers?.get("origin") !== new URL(context.context.baseURL).origin) {
              throw new APIError("FORBIDDEN", {
                message: "OAuth approval and revocation require a same-origin request.",
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher(context) {
            return context.path === "/device/approve";
          },
          handler: createAuthMiddleware(async function recordApprovedDeviceConsent(context) {
            const approved = z
              .object({ success: z.literal(true) })
              .safeParse(context.context.returned);
            if (!approved.success) {
              return;
            }
            const session = await getSessionFromCtx(context);
            if (!session) {
              return;
            }
            const device = await context.context.adapter.findOne<{
              status: string;
              userId: string;
              oauthClientId: string | null;
              scope: string | null;
              resources: string[] | null;
            }>({
              model: "deviceCode",
              where: [
                { field: "userCode", value: context.body.userCode },
                { field: "userId", value: session.user.id },
              ],
              select: ["status", "userId", "oauthClientId", "scope", "resources"],
            });
            if (device?.status !== "approved" || !device.oauthClientId) {
              return;
            }
            const clientId = device.oauthClientId;
            // Device Authorization does not persist an OAuth Provider consent of its own.
            await context.context.adapter.transaction(async (adapter) => {
              const existing = await adapter.findOne<{ id: string }>({
                model: "oauthConsent",
                select: ["id"],
                where: [
                  { field: "userId", value: session.user.id },
                  { field: "clientId", value: clientId },
                ],
              });
              const approvedAt = new Date();
              const scopes = (device.scope ?? "").split(/\s+/).filter(Boolean);
              if (existing) {
                await adapter.update({
                  model: "oauthConsent",
                  where: [{ field: "id", value: existing.id }],
                  update: {
                    scopes,
                    resources: device.resources,
                    requestedUserInfoClaims: [],
                    updatedAt: approvedAt,
                  },
                });
              } else {
                await adapter.create({
                  model: "oauthConsent",
                  data: {
                    userId: session.user.id,
                    clientId,
                    scopes,
                    resources: device.resources,
                    requestedUserInfoClaims: [],
                    createdAt: approvedAt,
                    updatedAt: approvedAt,
                  },
                });
              }
            });
          }),
        },
      ],
    },
    endpoints: {
      reviewBackofficeOAuthConsent: createAuthEndpoint(
        "/backoffice/oauth/consent-details",
        {
          method: "POST",
          use: [sessionMiddleware],
          body: backofficeOAuthConsentRequestSchema,
        },
        async function reviewSignedOAuthConsent(context) {
          // OAuth Provider's before hook verifies every oauth_query before endpoint dispatch.
          const query = new URLSearchParams(context.body.oauth_query);
          const clientId = query.get("client_id");
          const redirectUri = query.get("redirect_uri");
          if (!clientId || !redirectUri) {
            throw new APIError("BAD_REQUEST", { message: "OAuth consent request is invalid." });
          }
          const client = await context.context.adapter.findOne<{
            clientId: string;
            name: string | null;
            disabled: boolean | null;
            redirectUris: string[];
          }>({
            model: "oauthClient",
            select: ["clientId", "name", "disabled", "redirectUris"],
            where: [{ field: "clientId", value: clientId }],
          });
          if (!client || client.disabled || !client.redirectUris.includes(redirectUri)) {
            throw new APIError("BAD_REQUEST", {
              message: "OAuth consent client or callback is unavailable.",
            });
          }
          return context.json({
            clientId,
            clientName: client.name ?? clientId,
            userEmail: context.context.session.user.email,
            scopes: (query.get("scope") ?? "").split(/\s+/).filter(Boolean),
            redirectUri,
            resources: query.getAll("resource"),
            claimsRequest: query.get("claims"),
          });
        },
      ),
      listBackofficeOAuthConsents: createAuthEndpoint(
        "/backoffice/oauth/consents",
        {
          method: "GET",
          use: [sessionMiddleware],
          query: backofficeOAuthConsentListInputSchema,
        },
        async function listUserOAuthConsents(context) {
          return context.json(
            await listBackofficeOAuthConsentPage(context.context.adapter, {
              userId: context.context.session.user.id,
              ...context.query,
            }),
          );
        },
      ),
      revokeBackofficeOAuthConsent: createAuthEndpoint(
        "/backoffice/oauth/revoke-consent",
        {
          method: "POST",
          use: [sessionMiddleware],
          body: backofficeOAuthConsentRevokeInputSchema,
        },
        async function revokeUserOAuthConsent(context) {
          const userId = context.context.session.user.id;
          const { clientId } = context.body;
          await context.context.adapter.transaction(async (adapter) => {
            const where = [
              { field: "userId", value: userId },
              { field: "clientId", value: clientId },
            ];
            // Delete access tokens first because opaque tokens may reference refresh tokens.
            await adapter.deleteMany({ model: "oauthAccessToken", where });
            await adapter.deleteMany({ model: "oauthRefreshToken", where });
            await adapter.deleteMany({
              model: "deviceCode",
              where: [
                { field: "userId", value: userId },
                { field: "oauthClientId", value: clientId },
              ],
            });
            await adapter.deleteMany({ model: "oauthConsent", where });
          });
          return context.json({ revoked: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
