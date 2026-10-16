import { type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";

import { issueBackofficeTokenInputSchema } from "@/fragno/auth/contracts";
import {
  backofficeAccessTokenCookieAttributes,
  backofficeAccessTokenCookieName,
  issueBackofficeJwt,
} from "@/fragno/auth/token-lifecycle";

import {
  BackofficeUserTokenGrantForbiddenError,
  type ResolveBackofficeUserTokenGrant,
} from "./backoffice-user-token-grant";

export function createBackofficeTokenPlugin(input: {
  secureCookies: boolean;
  resolveBackofficeUserTokenGrant: ResolveBackofficeUserTokenGrant;
}): BetterAuthPlugin {
  return {
    id: "fragno-backoffice-token",
    endpoints: {
      clearBackofficeToken: createAuthEndpoint(
        "/backoffice-sign-out",
        { method: "POST", requireHeaders: true },
        async function revokeBackofficeCredentials(context) {
          const sessionToken = await context.getSignedCookie(
            context.context.authCookies.sessionToken.name,
            context.context.secret,
          );
          if (sessionToken) {
            await context.context.internalAdapter.deleteSession(sessionToken);
          }

          deleteSessionCookie(context);
          for (const secure of [false, true]) {
            context.setCookie(backofficeAccessTokenCookieName(secure), "", {
              ...backofficeAccessTokenCookieAttributes(secure),
              maxAge: 0,
            });
          }
          return context.json({ sessionRevoked: true, credentialsCleared: true });
        },
      ),
      issueBackofficeToken: createAuthEndpoint(
        "/backoffice-token",
        {
          method: "POST",
          requireHeaders: true,
          body: issueBackofficeTokenInputSchema,
          use: [sessionMiddleware],
        },
        async function issueOrganizationScopedBackofficeToken(context) {
          let grant;
          try {
            grant = await input.resolveBackofficeUserTokenGrant(context.context.adapter, {
              userId: context.context.session.user.id,
              scope: context.body.organizationId
                ? { kind: "org", orgId: context.body.organizationId }
                : null,
              organizationSelection: context.body.selection,
            });
          } catch (error) {
            if (error instanceof BackofficeUserTokenGrantForbiddenError) {
              throw new APIError("FORBIDDEN", { message: error.message });
            }
            throw error;
          }

          if (grant.status === "organization_provisioning") {
            context.setStatus(202);
            return context.json(grant);
          }

          const issued = await issueBackofficeJwt(context, {
            ...grant.authority,
            scopeRestriction: null,
          });
          context.setCookie(backofficeAccessTokenCookieName(!input.secureCookies), "", {
            ...backofficeAccessTokenCookieAttributes(!input.secureCookies),
            maxAge: 0,
          });
          context.setCookie(
            backofficeAccessTokenCookieName(input.secureCookies),
            issued.token,
            backofficeAccessTokenCookieAttributes(input.secureCookies),
          );

          return context.json({
            expiresAt: issued.expiresAt.toISOString(),
            organization: grant.authority.organization
              ? {
                  id: grant.authority.organization.id,
                  slug: grant.authority.organization.slug,
                }
              : null,
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
