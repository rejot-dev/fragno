import { type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { z } from "zod";

import { issueBackofficeTokenInputSchema } from "@/fragno/auth/contracts";
import {
  backofficeAccessTokenCookieAttributes,
  backofficeAccessTokenCookieName,
  issueBackofficeJwt,
} from "@/fragno/auth/token-lifecycle";
import {
  buildBackofficeAuthBootstrapPath,
  buildBackofficeLoginPath,
} from "@/routes/backoffice/auth-navigation";

import {
  BackofficeTokenGrantForbiddenError,
  type ResolveBackofficeScopeTokenGrant,
} from "./better-auth-oauth";

export function createBackofficeTokenPlugin(input: {
  isDevelopment: boolean;
  resolveBackofficeScopeTokenGrant: ResolveBackofficeScopeTokenGrant;
}): BetterAuthPlugin {
  return {
    id: "fragno-backoffice-token",
    endpoints: {
      enterBackoffice: createAuthEndpoint(
        "/backoffice-entry",
        {
          method: "GET",
          query: z.object({ returnTo: z.string().optional() }),
        },
        async function enterBackofficeWithSession(context) {
          const returnTo = context.query.returnTo;
          const sessionToken = await context.getSignedCookie(
            context.context.authCookies.sessionToken.name,
            context.context.secret,
          );
          const session = sessionToken
            ? await context.context.internalAdapter.findSession(sessionToken)
            : null;
          const sessionIsValid = Boolean(
            session && session.session.expiresAt.getTime() > Date.now(),
          );
          if (!sessionIsValid && sessionToken) {
            deleteSessionCookie(context);
          }
          const destination = sessionIsValid
            ? buildBackofficeAuthBootstrapPath(returnTo)
            : buildBackofficeLoginPath(returnTo);
          throw context.redirect(new URL(destination, context.context.baseURL).toString());
        },
      ),
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
          for (const isDevelopmentCookie of [true, false]) {
            context.setCookie(backofficeAccessTokenCookieName(isDevelopmentCookie), "", {
              ...backofficeAccessTokenCookieAttributes(isDevelopmentCookie),
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
            grant = await input.resolveBackofficeScopeTokenGrant(context.context.adapter, {
              userId: context.context.session.user.id,
              scope: context.body.organizationId
                ? { kind: "org", orgId: context.body.organizationId }
                : null,
            });
          } catch (error) {
            if (error instanceof BackofficeTokenGrantForbiddenError) {
              throw new APIError("FORBIDDEN", { message: error.message });
            }
            throw error;
          }

          if (grant.status === "organization_provisioning") {
            context.setStatus(202);
            return context.json(grant);
          }

          const issued = await issueBackofficeJwt(context, grant.authority);
          context.setCookie(backofficeAccessTokenCookieName(!input.isDevelopment), "", {
            ...backofficeAccessTokenCookieAttributes(!input.isDevelopment),
            maxAge: 0,
          });
          context.setCookie(
            backofficeAccessTokenCookieName(input.isDevelopment),
            issued.token,
            backofficeAccessTokenCookieAttributes(input.isDevelopment),
          );

          return context.json({
            expiresAt: issued.expiresAt.toISOString(),
            organizationId:
              grant.authority.scope.kind === "org" || grant.authority.scope.kind === "project"
                ? grant.authority.scope.orgId
                : null,
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
