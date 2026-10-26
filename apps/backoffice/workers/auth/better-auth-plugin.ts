import type { BackofficeJurisdiction } from "@fragno-dev/backoffice-api/v0/shared/scope";
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
  BackofficeUserTokenGrantForbiddenError,
  type ResolveBackofficeUserTokenGrant,
} from "./backoffice-user-token-grant";

/**
 * The organization plugin's session field. It remembers the organization of the browser's last
 * access token, so a token minted later, after the previous one expired, keeps that organization.
 */
const activeOrganizationSessionSchema = z.object({
  activeOrganizationId: z.string().nullish(),
});

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
          const { session, user } = context.context.session;
          const preferredOrganizationId =
            activeOrganizationSessionSchema.parse(session).activeOrganizationId ?? null;
          const organizationId =
            context.body.selection === "required"
              ? context.body.organizationId
              : preferredOrganizationId;
          // The session names its organization by ID; its scope also names where it is kept.
          const organization = organizationId
            ? await context.context.adapter.findOne<{
                jurisdiction: BackofficeJurisdiction | null;
              }>({
                model: "organization",
                select: ["jurisdiction"],
                where: [{ field: "id", value: organizationId }],
              })
            : null;
          let authority;
          try {
            authority = await input.resolveBackofficeUserTokenGrant(context.context.adapter, {
              userId: user.id,
              scope: organizationId
                ? {
                    kind: "org",
                    orgId: organizationId,
                    jurisdiction: organization?.jurisdiction ?? null,
                  }
                : null,
              organizationSelection: context.body.selection,
            });
          } catch (error) {
            if (error instanceof BackofficeUserTokenGrantForbiddenError) {
              throw new APIError("FORBIDDEN", { message: error.message });
            }
            throw error;
          }

          const issued = await issueBackofficeJwt(context, {
            ...authority,
            scopeRestriction: null,
          });
          const issuedOrganizationId = authority.organization?.id ?? null;
          if (issuedOrganizationId !== preferredOrganizationId) {
            await context.context.internalAdapter.updateSession(session.token, {
              activeOrganizationId: issuedOrganizationId,
            });
          }
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
            organization: authority.organization
              ? {
                  id: authority.organization.id,
                  slug: authority.organization.slug,
                }
              : null,
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
