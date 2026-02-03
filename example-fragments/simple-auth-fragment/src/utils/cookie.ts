/**
 * Cookie utilities for session management
 */

export const COOKIE_NAME = "sessionid";
const MAX_AGE = 2592000; // 30 days in seconds

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  maxAge?: number;
  path?: string;
}

/**
 * Parse cookies from a Cookie header string
 */
export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(";");

  for (const pair of pairs) {
    const [key, ...valueParts] = pair.split("=");
    const trimmedKey = key?.trim();
    const value = valueParts.join("=").trim();

    if (trimmedKey) {
      cookies[trimmedKey] = decodeURIComponent(value);
    }
  }

  return cookies;
}

/**
 * Build a Set-Cookie header string with security attributes
 */
export function buildSetCookieHeader(value: string, options: CookieOptions = {}): string {
  const {
    httpOnly = true,
    secure = true,
    sameSite = "Strict",
    maxAge = MAX_AGE,
    path = "/",
  } = options;

  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    `Path=${path}`,
  ];

  if (httpOnly) {
    parts.push("HttpOnly");
  }

  if (secure) {
    parts.push("Secure");
  }

  if (sameSite) {
    parts.push(`SameSite=${sameSite}`);
  }

  return parts.join("; ");
}

/**
 * Build a Set-Cookie header to clear the session cookie
 */
export function buildClearCookieHeader(): string {
  return buildSetCookieHeader("", { maxAge: 0 });
}

/**
 * Extract session ID from headers, checking cookies first, then query/body
 */
export function extractSessionId(
  headers: Headers,
  queryParam?: string | null,
  bodySessionId?: string,
): string | null {
  // First, try to get from cookies
  const cookieHeader = headers.get("Cookie");
  const cookies = parseCookies(cookieHeader);
  const sessionIdFromCookie = cookies[COOKIE_NAME];

  if (sessionIdFromCookie) {
    return sessionIdFromCookie;
  }

  // Fall back to query parameter
  if (queryParam) {
    return queryParam;
  }

  // Fall back to body
  if (bodySessionId) {
    return bodySessionId;
  }

  return null;
}
