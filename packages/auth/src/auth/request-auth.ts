import { parseCookies, resolveAuthCookieName, type CookieOptions } from "../utils/cookie";
import type { AuthCredentialStrategy } from "./credential-strategy";
import type { ResolveRequestAuthResult, ResolveRequestCredentialResult } from "./types";

export const parseBearerToken = (
  authorizationHeader: string | null,
): string | "malformed" | null => {
  if (authorizationHeader == null) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) {
    return "malformed";
  }

  const token = match[1]?.trim();
  if (!token) {
    return "malformed";
  }

  return token;
};

export const resolveRequestCredential = (
  headers: Headers,
  cookieOptions?: CookieOptions,
): ResolveRequestCredentialResult => {
  const authorization = headers.get("Authorization");
  const bearerToken = parseBearerToken(authorization);
  if (bearerToken === "malformed") {
    return { ok: false, reason: "malformed" };
  }
  if (bearerToken) {
    return {
      ok: true,
      credential: {
        token: bearerToken,
        source: "authorization-header",
      },
    };
  }

  const cookies = parseCookies(headers.get("Cookie"));
  const cookieToken = cookies[resolveAuthCookieName(cookieOptions)];
  if (cookieToken) {
    return {
      ok: true,
      credential: {
        token: cookieToken,
        source: "cookie",
      },
    };
  }

  return { ok: false, reason: "missing" };
};

export const getRequestAuth = (input: {
  headers: Headers;
  strategy: AuthCredentialStrategy;
}): Promise<ResolveRequestAuthResult> => {
  return input.strategy.resolveRequestAuth({ headers: input.headers });
};
