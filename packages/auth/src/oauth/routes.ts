import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import type { authFragmentDefinition } from "..";
import { buildSetCookieHeader, extractSessionId } from "../utils/cookie";
import { normalizeOAuthConfig } from "./utils";
import type { AnyOAuthProvider } from "./types";

const parseScopes = (value: string | null): string[] | undefined => {
  if (!value) {
    return undefined;
  }
  const scopes = value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
};

const resolveRedirectUri = (
  provider: AnyOAuthProvider | undefined,
  fallback?: string,
): string | null => {
  const providerRedirect = provider?.options?.redirectURI;
  if (typeof providerRedirect === "string" && providerRedirect.length > 0) {
    return providerRedirect;
  }
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback;
  }
  return null;
};

export const oauthRoutesFactory = defineRoutes<typeof authFragmentDefinition>().create(
  ({ services, config }) => {
    const oauthConfig = normalizeOAuthConfig(config.oauth);

    return [
      defineRoute({
        method: "GET",
        path: "/oauth/:provider/authorize",
        queryParameters: ["redirectUri", "returnTo", "link", "sessionId", "scope", "loginHint"],
        outputSchema: z.object({
          url: z.string(),
        }),
        errorCodes: [
          "oauth_disabled",
          "provider_not_found",
          "missing_redirect_uri",
          "redirect_uri_mismatch",
          "session_invalid",
        ],
        handler: async function ({ query, headers, pathParams }, { json, error }) {
          if (!oauthConfig) {
            return error({ message: "OAuth is not configured", code: "oauth_disabled" }, 400);
          }

          const providerId = pathParams.provider;
          const provider = oauthConfig.providers[providerId];
          if (!provider) {
            return error({ message: "Unknown provider", code: "provider_not_found" }, 404);
          }

          const redirectUri = resolveRedirectUri(provider, oauthConfig.defaultRedirectUri);
          if (!redirectUri) {
            return error({ message: "Missing redirect URI", code: "missing_redirect_uri" }, 400);
          }

          const requestedRedirect = query.get("redirectUri");
          if (requestedRedirect && requestedRedirect !== redirectUri) {
            return error({ message: "Redirect URI mismatch", code: "redirect_uri_mismatch" }, 400);
          }

          const link = query.get("link") === "true";
          const sessionId = link ? extractSessionId(headers, query.get("sessionId")) : null;

          const [stateResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.createOAuthState({
                providerId,
                redirectUri,
                returnTo: query.get("returnTo"),
                sessionId,
                link,
              }),
            ])
            .execute();

          if (!stateResult.ok) {
            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          const scopes = parseScopes(query.get("scope"));
          const loginHint = query.get("loginHint") ?? undefined;
          const url = await provider.createAuthorizationURL({
            state: stateResult.state,
            redirectURI: redirectUri,
            scopes,
            loginHint,
          });

          return json({ url: url.toString() });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/oauth/:provider/callback",
        queryParameters: ["code", "state", "requestSignUp"],
        outputSchema: z.object({
          sessionId: z.string(),
          userId: z.string(),
          email: z.string(),
          role: z.enum(["user", "admin"]),
          returnTo: z.string().nullable(),
        }),
        errorCodes: [
          "oauth_disabled",
          "provider_not_found",
          "missing_redirect_uri",
          "invalid_code",
          "invalid_state",
          "email_required",
          "signup_disabled",
          "signup_required",
          "user_banned",
        ],
        handler: async function ({ query, pathParams }, { json, error }) {
          if (!oauthConfig) {
            return error({ message: "OAuth is not configured", code: "oauth_disabled" }, 400);
          }

          const providerId = pathParams.provider;
          const provider = oauthConfig.providers[providerId];
          if (!provider) {
            return error({ message: "Unknown provider", code: "provider_not_found" }, 404);
          }

          const code = query.get("code");
          const state = query.get("state");
          if (!code) {
            return error({ message: "Missing code", code: "invalid_code" }, 400);
          }
          if (!state) {
            return error({ message: "Missing state", code: "invalid_state" }, 400);
          }

          const redirectUri = resolveRedirectUri(provider, oauthConfig.defaultRedirectUri);
          if (!redirectUri) {
            return error({ message: "Missing redirect URI", code: "missing_redirect_uri" }, 400);
          }

          const tokens = await provider.validateAuthorizationCode({
            code,
            redirectURI: redirectUri,
          });
          if (!tokens) {
            return error({ message: "Invalid code", code: "invalid_code" }, 401);
          }

          const userInfo = await provider.getUserInfo(tokens);
          if (!userInfo) {
            return error({ message: "Unable to load profile", code: "invalid_code" }, 401);
          }

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.handleOAuthCallback({
                providerId,
                state,
                tokens,
                userInfo: userInfo.user,
                rawProfile: userInfo.data as Record<string, unknown>,
                provider,
                requestSignUp: query.get("requestSignUp") === "true",
              }),
            ])
            .execute();

          if (!result.ok) {
            const status =
              result.code === "invalid_state"
                ? 400
                : result.code === "email_required"
                  ? 400
                  : result.code === "signup_disabled"
                    ? 403
                    : result.code === "signup_required"
                      ? 403
                      : result.code === "user_banned"
                        ? 403
                        : 400;
            return error({ message: "OAuth failed", code: result.code }, status);
          }

          const setCookieHeader = buildSetCookieHeader(result.sessionId, config.cookieOptions);

          if (result.returnTo) {
            return new Response(null, {
              status: 302,
              headers: {
                "Set-Cookie": setCookieHeader,
                Location: result.returnTo,
              },
            });
          }

          return json(
            {
              sessionId: result.sessionId,
              userId: result.userId,
              email: result.email,
              role: result.role,
              returnTo: result.returnTo,
            },
            {
              headers: {
                "Set-Cookie": setCookieHeader,
              },
            },
          );
        },
      }),
    ];
  },
);
