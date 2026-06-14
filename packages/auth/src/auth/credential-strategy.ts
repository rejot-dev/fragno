import { buildClearCookieHeader, buildSetCookieHeader, type CookieOptions } from "../utils/cookie";
import { resolveRequestCredential } from "./request-auth";
import {
  mintSessionAccessToken,
  resolveAccessTokenConfig,
  resolveRefreshCookieName,
  verifySessionAccessToken,
  type SessionAccessTokenConfig,
} from "./session-access-token";
import type {
  AuthPrincipal,
  IssuedAuthCredential,
  ResolveRequestAuthResult,
  ValidatedCredential,
  CreatedCredential,
} from "./types";

export type AuthResponseHeaders = Array<[string, string]>;

export interface ResolveRequestAuthInput {
  headers: Headers;
}

export interface IssueCredentialInput {
  userId: string;
  activeOrganizationId?: string | null;
}

export interface ClearCredentialInput {
  principal?: AuthPrincipal | null;
}

export interface MaybeReissueCredentialInput {
  principal: AuthPrincipal;
  activeOrganizationId?: string | null;
}

export interface AuthCredentialStrategy {
  name: "session";
  resolveRequestAuth(input: ResolveRequestAuthInput): Promise<ResolveRequestAuthResult>;
  issueCredential(input: IssueCredentialInput): Promise<IssuedAuthCredential>;
  clearCredential(input: ClearCredentialInput): Promise<{ headers?: HeadersInit }>;
  maybeReissueCredential?(input: MaybeReissueCredentialInput): Promise<IssuedAuthCredential | null>;
}

interface SessionCredentialStrategyDependencies {
  cookieOptions?: CookieOptions;
  accessTokens?: SessionAccessTokenConfig;
  validateCredential: (credentialToken: string) => Promise<ValidatedCredential | null>;
  issueCredential: (
    userId: string,
    options?: { activeOrganizationId?: string | null },
  ) => Promise<{ ok: true; credential: CreatedCredential } | { ok: false; code: string }>;
  invalidateCredential: (credentialToken: string) => Promise<boolean>;
}

export const createSessionCredentialStrategy = (
  dependencies: SessionCredentialStrategyDependencies,
): AuthCredentialStrategy => {
  const accessTokens = resolveAccessTokenConfig(dependencies.accessTokens);

  return {
    name: "session",
    async resolveRequestAuth({ headers }) {
      const resolvedCredential = resolveRequestCredential(headers, dependencies.cookieOptions);
      if (!resolvedCredential.ok) {
        return resolvedCredential;
      }

      if (accessTokens) {
        if (
          resolvedCredential.credential.source === "authorization-header" &&
          !accessTokens.acceptBearer
        ) {
          return { ok: false, reason: "invalid" };
        }
        if (resolvedCredential.credential.source === "cookie" && !accessTokens.issueCookie) {
          return { ok: false, reason: "invalid" };
        }
        const principal = await verifySessionAccessToken({
          config: accessTokens,
          token: resolvedCredential.credential.token,
          source: resolvedCredential.credential.source,
        });
        return principal ? { ok: true, principal } : { ok: false, reason: "invalid" };
      }

      const session = await dependencies.validateCredential(resolvedCredential.credential.token);
      if (!session) {
        return { ok: false, reason: "invalid" };
      }

      return {
        ok: true,
        principal: {
          user: {
            id: session.user.id,
            email: session.user.email,
            role: session.user.role,
          },
          auth: {
            strategy: "session",
            credentialKind: "session",
            credentialSource: resolvedCredential.credential.source,
            credentialId: session.id,
            expiresAt: session.expiresAt,
            activeOrganizationId: session.activeOrganizationId,
          },
        },
      };
    },
    async issueCredential({ userId, activeOrganizationId }) {
      const result = await dependencies.issueCredential(userId, { activeOrganizationId });
      if (!result.ok) {
        throw new Error(`Unable to create session credential: ${result.code}`);
      }

      if (accessTokens) {
        const session = await dependencies.validateCredential(result.credential.id);
        if (!session) {
          throw new Error("Unable to load issued session credential");
        }
        return mintSessionAccessToken({ config: accessTokens, session });
      }

      return {
        token: result.credential.id,
        kind: "session",
        expiresAt: result.credential.expiresAt,
        activeOrganizationId: result.credential.activeOrganizationId,
      };
    },
    async clearCredential({ principal }) {
      if (principal?.auth.credentialId) {
        await dependencies.invalidateCredential(principal.auth.credentialId);
      }

      return {
        headers: buildClearedCredentialHeaders(dependencies.cookieOptions, accessTokens != null),
      };
    },
    async maybeReissueCredential() {
      return null;
    },
  };
};

export const buildClearedCredentialHeaders = (
  cookieOptions?: CookieOptions,
  clearRefreshCookie = true,
): AuthResponseHeaders => {
  const headers: AuthResponseHeaders = [
    ["Set-Cookie", buildClearCookieHeader(cookieOptions ?? {})],
  ];
  if (clearRefreshCookie) {
    headers.push([
      "Set-Cookie",
      buildClearCookieHeader({ ...cookieOptions, name: resolveRefreshCookieName(cookieOptions) }),
    ]);
  }
  return headers;
};

export const buildIssuedCredentialHeaders = (
  credential: IssuedAuthCredential,
  cookieOptions?: CookieOptions,
  options?: { issueCookie?: boolean },
): AuthResponseHeaders => {
  if (options?.issueCookie === false) {
    return [];
  }
  const accessCookie = buildSetCookieHeader(credential.token, {
    ...cookieOptions,
    maxAge:
      credential.kind === "jwt" && credential.expiresAt
        ? Math.max(0, Math.floor((credential.expiresAt.getTime() - Date.now()) / 1000))
        : cookieOptions?.maxAge,
  });
  const headers: AuthResponseHeaders = [["Set-Cookie", accessCookie]];
  if (credential.kind !== "jwt" || !credential.refreshToken) {
    return headers;
  }
  headers.push([
    "Set-Cookie",
    buildSetCookieHeader(credential.refreshToken, {
      ...cookieOptions,
      name: resolveRefreshCookieName(cookieOptions),
      maxAge: credential.refreshExpiresAt
        ? Math.max(0, Math.floor((credential.refreshExpiresAt.getTime() - Date.now()) / 1000))
        : cookieOptions?.maxAge,
    }),
  ]);
  return headers;
};
