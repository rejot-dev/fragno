import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type {
  AppInstallationExternalAccount,
  AppInstallationResourceScope,
} from "@fragno-dev/backoffice-api/v0/apps";
import {
  backofficeScopeRootOwner,
  type BackofficeUserContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { z } from "zod";

import { requireMcpAuth } from "@better-auth/mcp";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";

import {
  appInstallationReaches,
  appInstallationTargetScope,
  type AppInstallationOwner,
} from "@/fragno/app-installations/contracts";
import {
  BackofficeExecutionTokenAuthenticationError,
  BackofficeExecutionTokenScopeError,
  type BackofficeExecutionTokenExchangeInput,
  type BackofficeExecutionTokenResult,
} from "@/fragno/auth/execution-token";
import {
  LEYWAY_MCP_OAUTH_SCOPE,
  LEYWAY_MCP_OAUTH_SCOPES,
  LEYWAY_MCP_PATH,
  type LeywayMcpRequestAuthorization,
} from "@/fragno/auth/mcp-oauth";
import { issueBackofficeJwt, issueInstalledAppJwt } from "@/fragno/auth/token-lifecycle";

import {
  BackofficeUserTokenGrantForbiddenError,
  type BackofficeUserTokenAuthority,
  type ResolveBackofficeUserTokenGrant,
} from "./backoffice-user-token-grant";
import { requireBackofficeOAuthConsent } from "./better-auth-oauth-consent";

type BetterAuthInstance = Pick<ReturnType<typeof betterAuth>, "handler" | "options" | "$context">;

const backofficeOAuthAccessTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  exp: z.number().int().positive(),
  client_id: z.string().min(1),
  azp: z.string().min(1),
  scope: z.string().min(1),
});
const oauthProviderJwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});

/**
 * Server-selected authority for a verified OAuth client.
 *
 * Only server-controlled first-party clients receive user authority. A registered app receives an
 * app-bound credential whose authority is limited by its installation.
 */
export type BackofficeOAuthExecutionPolicy =
  | { kind: "first-party-user" }
  | { kind: "installed-app"; appId: string };

type BackofficeExecutionTokenDependencies = {
  resolveClientPolicy(clientId: string): Promise<BackofficeOAuthExecutionPolicy | null>;
  resolveUserGrant: ResolveBackofficeUserTokenGrant;
  /** Returns the owner's active installation, or null when it approves nothing. */
  resolveActiveInstallation(input: { owner: AppInstallationOwner; appId: string }): Promise<{
    activation: number;
    resourceScope: AppInstallationResourceScope;
    externalAccount: AppInstallationExternalAccount | null;
  } | null>;
};

type BetterAuthContext = Awaited<BetterAuthInstance["$context"]>;

async function verifyBackofficeOAuthAccessToken(
  auth: BetterAuthInstance,
  input: Pick<BackofficeExecutionTokenExchangeInput, "requestUrl" | "oauthAccessToken">,
) {
  const audience = new URL(input.requestUrl).origin;
  try {
    const verifyBearerToken = oauthProviderResourceClient(auth).getActions().verifyBearerToken;
    const verifyOptions = {
      verifyOptions: { audience },
      // The resource-client runtime accepts a JWKS loader although its public type declares URLs.
      // Reading through Auth avoids a network call back to the same Worker.
      jwksUrl: async () => {
        const response = await auth.handler(new Request(new URL("/api/auth/jwks", audience)));
        if (!response.ok) {
          throw new Error(`OAuth provider JWKS request failed with status ${response.status}.`);
        }
        return oauthProviderJwksSchema.parse(await response.json());
      },
      requiredScopes: ["backoffice"],
    } as unknown as Parameters<typeof verifyBearerToken>[1];
    const payload = backofficeOAuthAccessTokenPayloadSchema.parse(
      await verifyBearerToken(input.oauthAccessToken, verifyOptions),
    );
    if (payload.client_id !== payload.azp || payload.exp * 1_000 <= Date.now()) {
      throw new Error("Backoffice execution OAuth token client identity or expiry is invalid.");
    }
    return payload;
  } catch (error) {
    throw new BackofficeExecutionTokenAuthenticationError(
      "Backoffice execution requires a valid OAuth access token.",
      { cause: error },
    );
  }
}

async function authorizeOAuthUserConsent(
  authContext: BetterAuthContext,
  payload: z.infer<typeof backofficeOAuthAccessTokenPayloadSchema>,
) {
  try {
    await requireBackofficeOAuthConsent(authContext.adapter, {
      userId: payload.sub,
      clientId: payload.client_id,
      scopes: payload.scope.split(/\s+/),
      requestedUserInfoClaims: [],
    });
  } catch (error) {
    if (error instanceof APIError) {
      throw new BackofficeExecutionTokenAuthenticationError(
        "Backoffice execution OAuth consent is missing or has been revoked.",
        { cause: error },
      );
    }
    throw error;
  }
}

/** Exchanges OAuth identity for scoped execution authority under an explicit server client policy. */
export async function exchangeBackofficeExecutionToken(
  auth: BetterAuthInstance,
  input: BackofficeExecutionTokenExchangeInput,
  dependencies: BackofficeExecutionTokenDependencies,
): Promise<BackofficeExecutionTokenResult> {
  const payload = await verifyBackofficeOAuthAccessToken(auth, input);
  const policy = await dependencies.resolveClientPolicy(payload.client_id);
  if (policy === null) {
    throw new BackofficeExecutionTokenAuthenticationError(
      "Backoffice execution is not permitted for this OAuth client.",
    );
  }

  const authContext = await auth.$context;
  // Client-credentials tokens name the client as their subject; they carry no user or consent.
  const userId = payload.sub === payload.client_id ? null : payload.sub;
  if (userId !== null) {
    await authorizeOAuthUserConsent(authContext, payload);
  }
  if (policy.kind === "installed-app") {
    return await exchangeInstalledAppToken(
      authContext,
      input,
      { userId, appId: policy.appId },
      dependencies,
    );
  }
  if (userId === null) {
    throw new BackofficeExecutionTokenAuthenticationError(
      "First-party execution requires a user OAuth token.",
    );
  }
  return await exchangeFirstPartyUserToken(authContext, input, userId, dependencies);
}

/**
 * Better Auth verifies the MCP request's Bearer or DPoP access token and answers invalid ones with
 * its sign-in challenge. Access tokens outlive revocation, so the client and consent are checked
 * live; the run then starts in the user's personal workspace.
 */
export async function authorizeMcpRequest(
  auth: BetterAuthInstance,
  request: Request,
  dependencies: Pick<BackofficeExecutionTokenDependencies, "resolveUserGrant"> & {
    isOAuthClientEnabled(clientId: string): Promise<boolean>;
  },
): Promise<LeywayMcpRequestAuthorization> {
  const { origin } = new URL(request.url);
  const resource = new URL(LEYWAY_MCP_PATH, origin).href;
  const challengeScopes = [...LEYWAY_MCP_OAUTH_SCOPES];
  const authorized: { scope: BackofficeUserContextScope | null } = { scope: null };
  let response: Response;
  try {
    response = await requireMcpAuth(
      auth,
      async (_request, claims) => {
        authorized.scope = await authorizeMcpUser(
          await auth.$context,
          backofficeOAuthAccessTokenPayloadSchema.parse(claims),
          dependencies,
        );
        return new Response(null, { status: 204 });
      },
      // Auth signs tokens as the origin, not Better Auth's `/api/auth` base URL.
      { resource, issuer: origin, requiredScopes: [LEYWAY_MCP_OAUTH_SCOPE], challengeScopes },
    )(request);
  } catch (error) {
    if (error instanceof BackofficeExecutionTokenAuthenticationError) {
      const challenge = createResourceServerChallenge(
        new APIError("UNAUTHORIZED", { error: "invalid_token", error_description: error.message }),
        resource,
        { challengeScopes, request },
      );
      if (!challenge) {
        throw new Error("Better Auth answers every unauthorized request with a challenge.", {
          cause: error,
        });
      }
      response = Response.json(challenge.body, {
        status: challenge.statusCode,
        headers: challenge.headers,
      });
    } else if (error instanceof BackofficeExecutionTokenScopeError) {
      response = Response.json({ error: "forbidden", message: error.message }, { status: 403 });
    } else {
      throw error;
    }
  }
  if (authorized.scope !== null) {
    return { kind: "authorized", scope: authorized.scope };
  }
  return {
    kind: "rejected",
    status: response.status,
    headers: [...response.headers],
    body: await response.text(),
  };
}

async function authorizeMcpUser(
  authContext: BetterAuthContext,
  payload: z.infer<typeof backofficeOAuthAccessTokenPayloadSchema>,
  dependencies: Parameters<typeof authorizeMcpRequest>[2],
) {
  if (!(await dependencies.isOAuthClientEnabled(payload.client_id))) {
    throw new BackofficeExecutionTokenAuthenticationError("This MCP client has been disabled.");
  }
  await authorizeOAuthUserConsent(authContext, payload);
  const authority = await resolveUserAuthority(
    authContext,
    { userId: payload.sub, scope: null, organizationSelection: "preferred" },
    dependencies,
  );
  if (!authority.personalScope) {
    throw new BackofficeExecutionTokenScopeError(
      "Finish setting up Leyway in the browser before running Codemode.",
    );
  }
  return authority.personalScope;
}

async function resolveUserAuthority(
  authContext: BetterAuthContext,
  input: Parameters<ResolveBackofficeUserTokenGrant>[1],
  dependencies: Pick<BackofficeExecutionTokenDependencies, "resolveUserGrant">,
): Promise<BackofficeUserTokenAuthority> {
  try {
    return await dependencies.resolveUserGrant(authContext.adapter, input);
  } catch (error) {
    if (error instanceof BackofficeUserTokenGrantForbiddenError) {
      throw new BackofficeExecutionTokenScopeError(error.message, { cause: error });
    }
    throw error;
  }
}

async function exchangeFirstPartyUserToken(
  authContext: BetterAuthContext,
  input: BackofficeExecutionTokenExchangeInput,
  userId: string,
  dependencies: BackofficeExecutionTokenDependencies,
): Promise<BackofficeExecutionTokenResult> {
  const authority = await resolveUserAuthority(
    authContext,
    {
      userId,
      scope: input.scope,
      organizationSelection: input.scope ? "required" : "preferred",
    },
    dependencies,
  );
  const scope = authority.scope;
  if (!scope) {
    throw new BackofficeExecutionTokenScopeError(
      "Finish setting up Leyway in the browser before using it here.",
    );
  }
  const issued = await issueBackofficeJwt(
    { context: authContext } as Parameters<typeof issueBackofficeJwt>[0],
    { ...authority, scopeRestriction: scope },
  );
  return {
    accessToken: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    scope,
  };
}

/**
 * Issues an app credential under an owner that has the app installed: within the installation's
 * approved resources, or in the app's own workspace there. A user token additionally requires the
 * user's own current access to the scope, never the installing user's; a client-credentials token
 * acts as the installation itself.
 */
async function exchangeInstalledAppToken(
  authContext: BetterAuthContext,
  input: BackofficeExecutionTokenExchangeInput,
  identity: { userId: string | null; appId: string },
  dependencies: BackofficeExecutionTokenDependencies,
): Promise<BackofficeExecutionTokenResult> {
  const scope = input.scope && appInstallationTargetScope(input.scope);
  if (!scope) {
    throw new BackofficeExecutionTokenScopeError(
      "Installed apps require an explicit organization or user scope, one of its projects, or the app's workspace.",
    );
  }
  if (identity.userId !== null) {
    await resolveUserAuthority(
      authContext,
      { userId: identity.userId, scope, organizationSelection: "required" },
      dependencies,
    );
  }
  const installation = await dependencies.resolveActiveInstallation({
    owner: backofficeScopeRootOwner(scope),
    appId: identity.appId,
  });
  if (!installation) {
    throw new BackofficeExecutionTokenScopeError(
      "This app is not installed by the requested scope's owner.",
    );
  }
  if (
    !appInstallationReaches(
      { appId: identity.appId, resourceScope: installation.resourceScope },
      scope,
    )
  ) {
    throw new BackofficeExecutionTokenScopeError(
      "This app's installation does not include the requested scope.",
    );
  }

  const issued = await issueInstalledAppJwt(
    { context: authContext } as Parameters<typeof issueInstalledAppJwt>[0],
    {
      actor:
        identity.userId === null
          ? { kind: "installation" }
          : { kind: "user", userId: identity.userId },
      installation: {
        appId: identity.appId,
        activation: installation.activation,
        externalAccount: installation.externalAccount,
      },
      scopeRestriction: scope,
    },
  );
  return { accessToken: issued.token, expiresAt: issued.expiresAt.toISOString(), scope };
}

/**
 * Authenticates an installed app's server through its client-credentials token. Used where the
 * app acts on its own behalf about an installation, never on behalf of a user.
 */
export async function authenticateInstalledAppClient(
  auth: BetterAuthInstance,
  input: Pick<BackofficeExecutionTokenExchangeInput, "requestUrl" | "oauthAccessToken">,
  dependencies: Pick<BackofficeExecutionTokenDependencies, "resolveClientPolicy">,
): Promise<{ appId: string }> {
  const payload = await verifyBackofficeOAuthAccessToken(auth, input);
  if (payload.sub !== payload.client_id) {
    throw new BackofficeExecutionTokenAuthenticationError(
      "This operation requires the app's client-credentials token, not a user token.",
    );
  }
  const policy = await dependencies.resolveClientPolicy(payload.client_id);
  if (policy?.kind !== "installed-app") {
    throw new BackofficeExecutionTokenAuthenticationError(
      "This OAuth client is not a registered Backoffice app.",
    );
  }
  return { appId: policy.appId };
}
