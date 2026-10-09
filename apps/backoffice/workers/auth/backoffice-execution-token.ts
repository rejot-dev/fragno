import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type {
  AppInstallationExternalAccount,
  AppInstallationResourceScope,
} from "@fragno-dev/backoffice-api/v0/apps";
import type { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { z } from "zod";

import { appInstallationResourceScopeContains } from "@/fragno/app-installations/contracts";
import {
  BackofficeExecutionTokenAuthenticationError,
  BackofficeExecutionTokenScopeError,
  type BackofficeExecutionTokenExchangeInput,
  type BackofficeExecutionTokenResult,
} from "@/fragno/auth/execution-token";
import { issueBackofficeJwt, issueInstalledAppJwt } from "@/fragno/auth/token-lifecycle";

import {
  BackofficeUserTokenGrantForbiddenError,
  type BackofficeUserTokenGrantResolution,
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
 * app-bound credential whose authority is limited by its organization installation.
 */
export type BackofficeOAuthExecutionPolicy =
  | { kind: "first-party-user" }
  | { kind: "installed-app"; appId: string };

type BackofficeExecutionTokenDependencies = {
  resolveClientPolicy(clientId: string): Promise<BackofficeOAuthExecutionPolicy | null>;
  resolveUserGrant: ResolveBackofficeUserTokenGrant;
  /** Returns the organization's active installation, or null when it approves nothing. */
  resolveActiveInstallation(input: { organizationId: string; appId: string }): Promise<{
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
    try {
      await requireBackofficeOAuthConsent(authContext.adapter, {
        userId,
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

async function resolveReadyUserGrant(
  authContext: BetterAuthContext,
  input: Parameters<ResolveBackofficeUserTokenGrant>[1],
  dependencies: BackofficeExecutionTokenDependencies,
): Promise<Extract<BackofficeUserTokenGrantResolution, { status: "ready" }>> {
  let grant: BackofficeUserTokenGrantResolution;
  try {
    grant = await dependencies.resolveUserGrant(authContext.adapter, input);
  } catch (error) {
    if (error instanceof BackofficeUserTokenGrantForbiddenError) {
      throw new BackofficeExecutionTokenScopeError(error.message, { cause: error });
    }
    throw error;
  }
  if (grant.status === "organization_provisioning") {
    throw new BackofficeExecutionTokenScopeError(
      "The authenticated user does not have an available Backoffice organization.",
    );
  }
  return grant;
}

async function exchangeFirstPartyUserToken(
  authContext: BetterAuthContext,
  input: BackofficeExecutionTokenExchangeInput,
  userId: string,
  dependencies: BackofficeExecutionTokenDependencies,
): Promise<BackofficeExecutionTokenResult> {
  const grant = await resolveReadyUserGrant(
    authContext,
    {
      userId,
      scope: input.scope,
      organizationSelection: input.scope ? "required" : "preferred",
    },
    dependencies,
  );
  const issued = await issueBackofficeJwt(
    { context: authContext } as Parameters<typeof issueBackofficeJwt>[0],
    { ...grant.authority, scopeRestriction: grant.authority.scope },
  );
  return {
    accessToken: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    scope: grant.authority.scope,
  };
}

/**
 * Issues an app credential for an organization or project that has the app installed, within the
 * installation's approved resources. A user token additionally requires the user's own current
 * membership, never the installing administrator's; a client-credentials token acts as the
 * installation itself.
 */
async function exchangeInstalledAppToken(
  authContext: BetterAuthContext,
  input: BackofficeExecutionTokenExchangeInput,
  identity: { userId: string | null; appId: string },
  dependencies: BackofficeExecutionTokenDependencies,
): Promise<BackofficeExecutionTokenResult> {
  const scope = input.scope;
  if (scope?.kind !== "org" && scope?.kind !== "project") {
    throw new BackofficeExecutionTokenScopeError(
      "Installed apps require an explicit organization or project scope.",
    );
  }
  if (identity.userId !== null) {
    await resolveReadyUserGrant(
      authContext,
      { userId: identity.userId, scope, organizationSelection: "required" },
      dependencies,
    );
  }
  const installation = await dependencies.resolveActiveInstallation({
    organizationId: scope.orgId,
    appId: identity.appId,
  });
  if (!installation) {
    throw new BackofficeExecutionTokenScopeError(
      "This app is not installed in the requested organization.",
    );
  }
  if (!appInstallationResourceScopeContains(installation.resourceScope, scope)) {
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
