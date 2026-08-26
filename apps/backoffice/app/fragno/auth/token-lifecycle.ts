import { signJWT } from "better-auth/plugins/jwt";
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";

export const ACCESS_TOKEN_ISSUER = "fragno-backoffice-auth";
export const ACCESS_TOKEN_AUDIENCE = "fragno-backoffice";
export const BACKOFFICE_JWT_LIFETIME_SECONDS = 15 * 60;

// These are public cookie names, not credentials; the cookie values remain HTTP-only.
const DEVELOPMENT_COOKIE_NAME = "fragno-backoffice.access_token";
const HOST_COOKIE_NAME = "__Host-fragno-backoffice.access_token";

export const backofficeJwtPayloadSchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  globalRole: z.enum(["user", "admin"]),
  organization: z
    .object({
      id: z.string().min(1),
      slug: z.string().min(1),
      roles: z.array(z.string().min(1)),
    })
    .nullable(),
  iss: z.literal(ACCESS_TOKEN_ISSUER),
  aud: z.literal(ACCESS_TOKEN_AUDIENCE),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(1),
});

export type BackofficeJwtPayload = z.infer<typeof backofficeJwtPayloadSchema>;

const betterAuthJwksSchema = z.object({
  keys: z.array(
    z.looseObject({
      kid: z.string(),
      kty: z.string(),
    }),
  ),
});

export const backofficeAccessTokenCookieName = (isDevelopment: boolean): string =>
  isDevelopment ? DEVELOPMENT_COOKIE_NAME : HOST_COOKIE_NAME;

export const backofficeAccessTokenCookieAttributes = (isDevelopment: boolean) => ({
  httpOnly: true,
  secure: !isDevelopment,
  sameSite: "lax" as const,
  path: "/",
  maxAge: BACKOFFICE_JWT_LIFETIME_SECONDS,
});

export const expiredBackofficeAccessTokenCookieHeaders = (): string[] =>
  [true, false].map((isDevelopment) => {
    const attributes = backofficeAccessTokenCookieAttributes(isDevelopment);
    return [
      `${backofficeAccessTokenCookieName(isDevelopment)}=`,
      `Path=${attributes.path}`,
      "Max-Age=0",
      "HttpOnly",
      attributes.secure ? "Secure" : null,
      "SameSite=Lax",
    ]
      .filter(Boolean)
      .join("; ");
  });

export const readBackofficeAccessTokenCookie = (cookieHeader: string | null): string | null => {
  if (!cookieHeader) {
    return null;
  }

  const acceptedNames = new Set([DEVELOPMENT_COOKIE_NAME, HOST_COOKIE_NAME]);
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const name = cookie.slice(0, separator).trim();
    if (acceptedNames.has(name)) {
      const value = cookie.slice(separator + 1).trim();
      if (value) {
        return value;
      }
    }
  }
  return null;
};

type BackofficeJwtSigningContext = Parameters<typeof signJWT>[0];

export const issueBackofficeJwt = async (
  context: BackofficeJwtSigningContext,
  authority: {
    userId: string;
    email: string;
    globalRole: "user" | "admin";
    organization: { id: string; slug: string; roles: string[] } | null;
  },
): Promise<{ token: string; expiresAt: Date }> => {
  const issuedAtEpochSeconds = Math.floor(Date.now() / 1_000);
  const expiresAtEpochSeconds = issuedAtEpochSeconds + BACKOFFICE_JWT_LIFETIME_SECONDS;
  const token = await signJWT(context, {
    options: {
      jwt: {
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        expirationTime: `${BACKOFFICE_JWT_LIFETIME_SECONDS}s`,
      },
    },
    payload: {
      sub: authority.userId,
      email: authority.email,
      globalRole: authority.globalRole,
      organization: authority.organization,
      iat: issuedAtEpochSeconds,
      exp: expiresAtEpochSeconds,
      jti: crypto.randomUUID(),
    },
  });

  return { token, expiresAt: new Date(expiresAtEpochSeconds * 1_000) };
};

type JwksFetchObject = {
  fetch(request: Request): Promise<Response>;
};

type DurableObjectJwksFetchObject = JwksFetchObject & {
  readonly id: { toString(): string };
};

function hasDurableObjectId(
  authObject: JwksFetchObject,
): authObject is DurableObjectJwksFetchObject {
  return "id" in authObject;
}

const BACKOFFICE_JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1_000;
const BACKOFFICE_JWKS_UNKNOWN_KEY_REFRESH_COOLDOWN_MS = 30 * 1_000;
const BACKOFFICE_JWKS_CACHE_MAX_AUTHORITIES = 8;

type BackofficeJwksResolver = ReturnType<typeof createLocalJWKSet>;

type BackofficeJwksCacheEntry = {
  resolver: BackofficeJwksResolver;
  refreshedAtEpochMs: number;
};

const backofficeJwksCacheByAuthority = new Map<string, BackofficeJwksCacheEntry>();
const backofficeJwksRefreshByAuthority = new Map<string, Promise<BackofficeJwksCacheEntry>>();
const backofficeUnknownKeyRefreshAtByAuthority = new Map<string, number>();
const backofficeJwksLocalAuthorityByAuthObject = new WeakMap<object, number>();
let nextBackofficeJwksLocalAuthority = 1;

function resolveBackofficeJwksCacheAuthority(
  authObject: JwksFetchObject,
  requestOrigin: string,
): string {
  // Request assembly creates a new Durable Object stub each time, but its id remains stable across
  // the Worker isolate. Local collaborators without an id stay isolated by object identity.
  if (hasDurableObjectId(authObject)) {
    return `${requestOrigin}#${authObject.id.toString()}`;
  }

  let localAuthority = backofficeJwksLocalAuthorityByAuthObject.get(authObject);
  if (localAuthority === undefined) {
    localAuthority = nextBackofficeJwksLocalAuthority;
    nextBackofficeJwksLocalAuthority += 1;
    backofficeJwksLocalAuthorityByAuthObject.set(authObject, localAuthority);
  }
  return `${requestOrigin}#local-${localAuthority}`;
}

const loadBackofficeJwks = async (
  authObject: JwksFetchObject,
  requestOrigin: string,
): Promise<JSONWebKeySet> => {
  const response = await authObject.fetch(new Request(new URL("/api/auth/jwks", requestOrigin)));
  if (!response.ok) {
    throw new Error(`Better Auth JWKS request failed with status ${response.status}.`);
  }
  return betterAuthJwksSchema.parse(await response.json()) as JSONWebKeySet;
};

function cacheBackofficeJwks(
  cacheAuthority: string,
  entry: BackofficeJwksCacheEntry,
): BackofficeJwksCacheEntry {
  backofficeJwksCacheByAuthority.delete(cacheAuthority);
  backofficeJwksCacheByAuthority.set(cacheAuthority, entry);

  while (backofficeJwksCacheByAuthority.size > BACKOFFICE_JWKS_CACHE_MAX_AUTHORITIES) {
    const oldestAuthority = backofficeJwksCacheByAuthority.keys().next().value;
    if (oldestAuthority === undefined) {
      break;
    }
    backofficeJwksCacheByAuthority.delete(oldestAuthority);
    backofficeUnknownKeyRefreshAtByAuthority.delete(oldestAuthority);
  }

  return entry;
}

async function refreshBackofficeJwks(
  authObject: JwksFetchObject,
  cacheAuthority: string,
  requestOrigin: string,
): Promise<BackofficeJwksCacheEntry> {
  const activeRefresh = backofficeJwksRefreshByAuthority.get(cacheAuthority);
  if (activeRefresh) {
    return await activeRefresh;
  }

  const refresh = (async () => {
    const jwks = await loadBackofficeJwks(authObject, requestOrigin);
    return cacheBackofficeJwks(cacheAuthority, {
      resolver: createLocalJWKSet(jwks),
      refreshedAtEpochMs: Date.now(),
    });
  })();
  backofficeJwksRefreshByAuthority.set(cacheAuthority, refresh);

  try {
    return await refresh;
  } finally {
    if (backofficeJwksRefreshByAuthority.get(cacheAuthority) === refresh) {
      backofficeJwksRefreshByAuthority.delete(cacheAuthority);
    }
  }
}

async function resolveBackofficeJwks(
  authObject: JwksFetchObject,
  cacheAuthority: string,
  requestOrigin: string,
): Promise<BackofficeJwksCacheEntry> {
  const cached = backofficeJwksCacheByAuthority.get(cacheAuthority);
  if (cached && Date.now() - cached.refreshedAtEpochMs < BACKOFFICE_JWKS_CACHE_MAX_AGE_MS) {
    return cached;
  }
  return await refreshBackofficeJwks(authObject, cacheAuthority, requestOrigin);
}

async function refreshBackofficeJwksForUnknownKey(
  authObject: JwksFetchObject,
  cacheAuthority: string,
  requestOrigin: string,
  attemptedEntry: BackofficeJwksCacheEntry,
): Promise<BackofficeJwksCacheEntry | null> {
  const activeRefresh = backofficeJwksRefreshByAuthority.get(cacheAuthority);
  if (activeRefresh) {
    return await activeRefresh;
  }

  const currentEntry = backofficeJwksCacheByAuthority.get(cacheAuthority);
  if (currentEntry && currentEntry !== attemptedEntry) {
    return currentEntry;
  }

  const now = Date.now();
  const previousRefreshAt = backofficeUnknownKeyRefreshAtByAuthority.get(cacheAuthority);
  if (
    previousRefreshAt !== undefined &&
    now - previousRefreshAt < BACKOFFICE_JWKS_UNKNOWN_KEY_REFRESH_COOLDOWN_MS
  ) {
    return null;
  }

  // The JWT kid is attacker-controlled. Record before awaiting I/O so failed refreshes are
  // throttled along with successful refreshes that still lack the requested key.
  backofficeUnknownKeyRefreshAtByAuthority.set(cacheAuthority, now);
  return await refreshBackofficeJwks(authObject, cacheAuthority, requestOrigin);
}

const verifyBackofficeJwtWithJwks = async (
  token: string,
  resolver: BackofficeJwksResolver,
): Promise<BackofficeJwtPayload> => {
  const verification = await jwtVerify(token, resolver, {
    issuer: ACCESS_TOKEN_ISSUER,
    audience: ACCESS_TOKEN_AUDIENCE,
  });
  return backofficeJwtPayloadSchema.parse(verification.payload);
};

export type BackofficeJwtVerificationResult =
  | { ok: true; payload: BackofficeJwtPayload }
  | { ok: false; reason: "missing" | "expired" | "invalid" };

export const verifyBackofficeJwt = async (
  token: string | null,
  requestUrl: string,
  authObject: JwksFetchObject,
): Promise<BackofficeJwtVerificationResult> => {
  if (!token) {
    return { ok: false, reason: "missing" };
  }

  const requestOrigin = new URL(requestUrl).origin;
  const cacheAuthority = resolveBackofficeJwksCacheAuthority(authObject, requestOrigin);
  const jwksEntry = await resolveBackofficeJwks(authObject, cacheAuthority, requestOrigin);

  try {
    return {
      ok: true,
      payload: await verifyBackofficeJwtWithJwks(token, jwksEntry.resolver),
    };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { ok: false, reason: "expired" };
    }
    if (!(error instanceof errors.JWKSNoMatchingKey)) {
      return { ok: false, reason: "invalid" };
    }
  }

  const refreshedEntry = await refreshBackofficeJwksForUnknownKey(
    authObject,
    cacheAuthority,
    requestOrigin,
    jwksEntry,
  );
  if (!refreshedEntry) {
    return { ok: false, reason: "invalid" };
  }

  try {
    const payload = await verifyBackofficeJwtWithJwks(token, refreshedEntry.resolver);
    backofficeUnknownKeyRefreshAtByAuthority.delete(cacheAuthority);
    return { ok: true, payload };
  } catch (error) {
    if (!(error instanceof errors.JWKSNoMatchingKey)) {
      backofficeUnknownKeyRefreshAtByAuthority.delete(cacheAuthority);
    }
    return {
      ok: false,
      reason: error instanceof errors.JWTExpired ? "expired" : "invalid",
    };
  }
};

export const verifyBackofficeJwtRequest = async (
  request: Request,
  authObject: JwksFetchObject,
): Promise<BackofficeJwtVerificationResult> =>
  await verifyBackofficeJwt(
    readBackofficeAccessTokenCookie(request.headers.get("cookie")),
    request.url,
    authObject,
  );
