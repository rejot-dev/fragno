import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { z } from "zod";

import {
  BackofficeExecutionTokenAuthenticationError,
  BackofficeExecutionTokenScopeError,
  type BackofficeExecutionTokenExchangeInput,
  type BackofficeExecutionTokenResult,
} from "@/fragno/auth/execution-token";
import { issueBackofficeJwt } from "@/fragno/auth/token-lifecycle";

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

/** Only server-controlled first-party clients may currently receive user execution authority. */
export type BackofficeOAuthExecutionPolicy = { kind: "first-party-user" };

type BackofficeExecutionTokenDependencies = {
  resolveClientPolicy(clientId: string): Promise<BackofficeOAuthExecutionPolicy | null>;
  resolveUserGrant: ResolveBackofficeUserTokenGrant;
};

async function verifyBackofficeOAuthAccessToken(
  auth: BetterAuthInstance,
  input: BackofficeExecutionTokenExchangeInput,
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
  let grant: BackofficeUserTokenGrantResolution;
  switch (policy.kind) {
    case "first-party-user":
      try {
        grant = await dependencies.resolveUserGrant(authContext.adapter, {
          userId: payload.sub,
          scope: input.scope,
          organizationSelection: input.scope ? "required" : "preferred",
        });
      } catch (error) {
        if (error instanceof BackofficeUserTokenGrantForbiddenError) {
          throw new BackofficeExecutionTokenScopeError(error.message, { cause: error });
        }
        throw error;
      }
      break;
  }
  if (grant.status === "organization_provisioning") {
    throw new BackofficeExecutionTokenScopeError(
      "The authenticated user does not have an available Backoffice organization.",
    );
  }

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
