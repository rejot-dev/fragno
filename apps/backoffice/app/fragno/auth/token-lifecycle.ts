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
    organization: { id: string; roles: string[] } | null;
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

const jwksByAuthObject = new WeakMap<object, JSONWebKeySet>();

const loadBackofficeJwks = async (
  authObject: JwksFetchObject,
  baseUrl: string,
): Promise<JSONWebKeySet> => {
  const response = await authObject.fetch(new Request(new URL("/api/auth/jwks", baseUrl)));
  if (!response.ok) {
    throw new Error(`Better Auth JWKS request failed with status ${response.status}.`);
  }
  return betterAuthJwksSchema.parse(await response.json()) as JSONWebKeySet;
};

const verifyBackofficeJwtWithJwks = async (
  token: string,
  jwks: JSONWebKeySet,
): Promise<BackofficeJwtPayload> => {
  const verification = await jwtVerify(token, createLocalJWKSet(jwks), {
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

  let jwks = jwksByAuthObject.get(authObject);
  if (!jwks) {
    jwks = await loadBackofficeJwks(authObject, new URL(requestUrl).origin);
    jwksByAuthObject.set(authObject, jwks);
  }

  try {
    return { ok: true, payload: await verifyBackofficeJwtWithJwks(token, jwks) };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { ok: false, reason: "expired" };
    }
    if (!(error instanceof errors.JWKSNoMatchingKey)) {
      return { ok: false, reason: "invalid" };
    }
  }

  const refreshedJwks = await loadBackofficeJwks(authObject, new URL(requestUrl).origin);
  jwksByAuthObject.set(authObject, refreshedJwks);

  try {
    return {
      ok: true,
      payload: await verifyBackofficeJwtWithJwks(token, refreshedJwks),
    };
  } catch (error) {
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
