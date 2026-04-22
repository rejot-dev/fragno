/**
 * Cookie utilities for auth credential management
 */

export const AUTH_COOKIE_NAME = "fragno_auth";
const MAX_AGE = 2592000; // 30 days in seconds

export interface CookieOptions {
  name?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  maxAge?: number;
  path?: string;
}

export const resolveAuthCookieName = (options?: CookieOptions): string =>
  options?.name ?? AUTH_COOKIE_NAME;

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
  const name = resolveAuthCookieName(options);
  const effectiveSecure = sameSite === "None" ? true : secure;

  const parts = [`${name}=${encodeURIComponent(value)}`, `Max-Age=${maxAge}`, `Path=${path}`];

  if (httpOnly) {
    parts.push("HttpOnly");
  }

  if (effectiveSecure) {
    parts.push("Secure");
  }

  if (sameSite) {
    parts.push(`SameSite=${sameSite}`);
  }

  return parts.join("; ");
}

/**
 * Build a Set-Cookie header to clear the auth cookie
 */
export function buildClearCookieHeader(options: CookieOptions = {}): string {
  return buildSetCookieHeader("", { ...options, maxAge: 0 });
}
