import { parseCookies, resolveAuthCookieName, type CookieOptions } from "../utils/cookie";
import type { AuthCredentialStrategy } from "./credential-strategy";
import type {
  ResolveRequestAuthResult,
  ResolveRequestCredentialResult,
  ResolvedRequestCredential,
} from "./types";

export type ParsedBearerToken =
  | { ok: true; token: string }
  | { ok: false; reason: "missing" | "malformed" };

export const parseBearerToken = (authorizationHeader: string | null): ParsedBearerToken => {
  if (authorizationHeader == null) {
    return { ok: false, reason: "missing" };
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) {
    return { ok: false, reason: "malformed" };
  }

  const token = match[1]?.trim();
  if (!token) {
    return { ok: false, reason: "malformed" };
  }

  return { ok: true, token };
};

export const hasMultipleRequestCredentials = (
  headers: Headers,
  cookieOptions?: CookieOptions,
): boolean => {
  const cookies = parseCookies(headers.get("Cookie"));
  return Boolean(
    cookies[resolveAuthCookieName(cookieOptions)] && headers.get("Authorization") !== null,
  );
};

export const resolveRequestCredentialCandidates = (
  headers: Headers,
  cookieOptions?: CookieOptions,
): ResolvedRequestCredential[] => {
  const credentials: ResolvedRequestCredential[] = [];
  const cookies = parseCookies(headers.get("Cookie"));
  const cookieToken = cookies[resolveAuthCookieName(cookieOptions)];
  if (cookieToken) {
    credentials.push({
      token: cookieToken,
      source: "cookie",
    });
  }

  const bearerToken = parseBearerToken(headers.get("Authorization"));
  if (bearerToken.ok) {
    credentials.push({
      token: bearerToken.token,
      source: "authorization-header",
    });
  }

  return credentials;
};

export const resolveRequestCredential = (
  headers: Headers,
  cookieOptions?: CookieOptions,
): ResolveRequestCredentialResult => {
  if (hasMultipleRequestCredentials(headers, cookieOptions)) {
    return { ok: false, reason: "multiple" };
  }

  const credentials = resolveRequestCredentialCandidates(headers, cookieOptions);
  const firstCredential = credentials[0];
  if (firstCredential) {
    return {
      ok: true,
      credential: firstCredential,
    };
  }

  const bearerToken = parseBearerToken(headers.get("Authorization"));
  if (!bearerToken.ok && bearerToken.reason === "malformed") {
    return { ok: false, reason: "malformed" };
  }

  return { ok: false, reason: "missing" };
};

export const getRequestAuth = (input: {
  headers: Headers;
  strategy: AuthCredentialStrategy;
}): Promise<ResolveRequestAuthResult> => {
  return input.strategy.resolveRequestAuth({ headers: input.headers });
};
