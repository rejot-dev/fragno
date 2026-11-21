import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type {
  AppInstallationExternalAccount,
  AppInstallationResourceScope,
} from "@fragno-dev/backoffice-api/v0/apps";
import { backofficeScopeRootOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { z } from "zod";

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
import { LEYWAY_MCP_OAUTH_SCOPE, LEYWAY_MCP_PATH } from "@/fragno/auth/mcp-oauth";
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

type BackofficeOAuthRequest = Pick<
  BackofficeExecutionTokenExchangeInput,
  "requestUrl" | "oauthAccessToken"
>;

async function verifyBackofficeOAuthAccessToken(
  auth: BetterAuthInstance,
  input: BackofficeOAuthRequest,
  resource: "execution" | "mcp" = "execution",
) {
  const origin = new URL(input.requestUrl).origin;
  const audience = resource === "mcp" ? new URL(LEYWAY_MCP_PATH, origin).href : origin;
  try {
    const verifyBearerToken = oauthProviderResourceClient(auth).getActions().verifyBearerToken;
    const verifyOptions = {
      verifyOptions: { audience, issuer: origin },
      // The resource-client runtime accepts a JWKS loader although its public type declares URLs.
      // Reading through Auth avoids a network call back to the same Worker.
      jwksUrl: async () => {
        const response = await auth.handler(new Request(new URL("/api/auth/jwks", origin)));
        if (!response.ok) {
          throw new Error(`OAuth provider JWKS request failed with status ${response.status}.`);
        }
        return oauthProviderJwksSchema.parse(await response.json());
      },
      requiredScopes: [resource === "mcp" ? LEYWAY_MCP_OAUTH_SCOPE : "backoffice"],
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

async function authorizeOAuthExecution(
  auth: BetterAuthInstance,
  input: BackofficeOAuthRequest,
  dependencies: Pick<BackofficeExecutionTokenDependencies, "resolveClientPolicy">,
) {
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
  return { policy, userId, authContext };
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
  const { policy, userId, authContext } = await authorizeOAuthExecution(auth, input, dependencies);
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

/** MCP credentials are OAuth grants for this resource and a consenting user. */
export async function authorizeMcpUser(
  auth: BetterAuthInstance,
  input: BackofficeOAuthRequest,
  dependencies: Pick<BackofficeExecutionTokenDependencies, "resolveUserGrant"> & {
    isMcpClientEnabled(clientId: string): Promise<boolean>;
  },
) {
  const payload = await verifyBackofficeOAuthAccessToken(auth, input, "mcp");
  if (
    payload.sub === payload.client_id ||
    !(await dependencies.isMcpClientEnabled(payload.client_id))
  ) {
    throw new BackofficeExecutionTokenAuthenticationError("MCP requires a Leyway user sign-in.");
  }
  const { sub: userId } = payload;
  const authContext = await auth.$context;
  await authorizeOAuthUserConsent(authContext, payload);
  const authority = await resolveUserAuthority(
    authContext,
    { userId, scope: null, organizationSelection: "preferred" },
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
  input: BackofficeOAuthRequest,
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
