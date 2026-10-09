import {
  type BackofficeContextScope,
  backofficeContextScopeSchema,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
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
  scopeRestriction: backofficeContextScopeSchema.nullable(),
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

/**
 * Installed apps receive a separate audience, so every user-credential verifier rejects them.
 * The credential names identities only; user and installation authority are resolved live.
 */
const INSTALLED_APP_ACCESS_TOKEN_AUDIENCE = "fragno-backoffice-installed-app";

const installedAppJwtPayloadSchema = z.object({
  sub: z.string().min(1),
  actor: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("user"), userId: z.string().min(1) }),
    z.strictObject({ kind: z.literal("installation") }),
  ]),
  installation: z.strictObject({
    appId: z.string().min(1),
    activation: z.number().int().positive(),
    externalAccount: z.strictObject({ id: z.string().min(1), label: z.string().min(1) }).nullable(),
  }),
  scopeRestriction: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("org"), orgId: z.string().min(1) }),
    z.strictObject({
      kind: z.literal("project"),
      orgId: z.string().min(1),
      projectId: z.string().min(1),
    }),
  ]),
  iss: z.literal(ACCESS_TOKEN_ISSUER),
  aud: z.literal(INSTALLED_APP_ACCESS_TOKEN_AUDIENCE),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(1),
});

export type InstalledAppJwtPayload = z.infer<typeof installedAppJwtPayloadSchema>;

/**
 * A browser-carried proof that an organization approved an app installation. It is not a
 * credential: only the app's authenticated server can redeem it, and only to claim that activation.
 */
const APP_INSTALLATION_CODE_AUDIENCE = "fragno-backoffice-app-installation-code";
const APP_INSTALLATION_CODE_LIFETIME_SECONDS = 5 * 60;

const appInstallationCodePayloadSchema = z.object({
  appId: z.string().min(1),
  organizationId: z.string().min(1),
  activation: z.number().int().positive(),
  iss: z.literal(ACCESS_TOKEN_ISSUER),
  aud: z.literal(APP_INSTALLATION_CODE_AUDIENCE),
  exp: z.number().int().positive(),
});

export type AppInstallationCodePayload = z.infer<typeof appInstallationCodePayloadSchema>;

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

async function signBackofficeAccessToken(
  context: BackofficeJwtSigningContext,
  audience: string,
  claims: Record<string, unknown>,
  lifetimeSeconds = BACKOFFICE_JWT_LIFETIME_SECONDS,
): Promise<{ token: string; expiresAt: Date }> {
  const issuedAtEpochSeconds = Math.floor(Date.now() / 1_000);
  const expiresAtEpochSeconds = issuedAtEpochSeconds + lifetimeSeconds;
  const token = await signJWT(context, {
    options: {
      jwt: {
        issuer: ACCESS_TOKEN_ISSUER,
        audience,
        expirationTime: `${lifetimeSeconds}s`,
      },
    },
    payload: {
      ...claims,
      iat: issuedAtEpochSeconds,
      exp: expiresAtEpochSeconds,
      jti: crypto.randomUUID(),
    },
  });

  return { token, expiresAt: new Date(expiresAtEpochSeconds * 1_000) };
}

export const issueBackofficeJwt = async (
  context: BackofficeJwtSigningContext,
  authority: {
    userId: string;
    email: string;
    globalRole: "user" | "admin";
    scopeRestriction: BackofficeContextScope | null;
    organization: { id: string; slug: string; roles: string[] } | null;
  },
): Promise<{ token: string; expiresAt: Date }> =>
  await signBackofficeAccessToken(context, ACCESS_TOKEN_AUDIENCE, {
    sub: authority.userId,
    email: authority.email,
    globalRole: authority.globalRole,
    scopeRestriction: authority.scopeRestriction,
    organization: authority.organization,
  });

/**
 * Binds an installed app, acting for a user or as itself, to one activation and scope. It carries
 * no role or grant snapshot; both are resolved live on every use.
 */
export async function issueInstalledAppJwt(
  context: BackofficeJwtSigningContext,
  authority: Pick<InstalledAppJwtPayload, "actor" | "installation" | "scopeRestriction">,
): Promise<{ token: string; expiresAt: Date }> {
  return await signBackofficeAccessToken(context, INSTALLED_APP_ACCESS_TOKEN_AUDIENCE, {
    sub:
      authority.actor.kind === "user"
        ? authority.actor.userId
        : `app:${authority.installation.appId}`,
    ...authority,
  });
}

export async function issueAppInstallationCode(
  context: BackofficeJwtSigningContext,
  installation: Pick<AppInstallationCodePayload, "appId" | "organizationId" | "activation">,
): Promise<{ token: string; expiresAt: Date }> {
  return await signBackofficeAccessToken(
    context,
    APP_INSTALLATION_CODE_AUDIENCE,
    { ...installation },
    APP_INSTALLATION_CODE_LIFETIME_SECONDS,
  );
}

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

type JwtPayloadVerifier<TPayload> = (
  token: string,
  resolver: BackofficeJwksResolver,
) => Promise<TPayload>;

const verifyBackofficeJwtWithJwks: JwtPayloadVerifier<BackofficeJwtPayload> = async (
  token,
  resolver,
) => {
  const verification = await jwtVerify(token, resolver, {
    issuer: ACCESS_TOKEN_ISSUER,
    audience: ACCESS_TOKEN_AUDIENCE,
  });
  return backofficeJwtPayloadSchema.parse(verification.payload);
};

const verifyInstalledAppJwtWithJwks: JwtPayloadVerifier<InstalledAppJwtPayload> = async (
  token,
  resolver,
) => {
  const verification = await jwtVerify(token, resolver, {
    issuer: ACCESS_TOKEN_ISSUER,
    audience: INSTALLED_APP_ACCESS_TOKEN_AUDIENCE,
  });
  return installedAppJwtPayloadSchema.parse(verification.payload);
};

/** API requests carry either kind of credential; the audience names which one it is. */
const backofficeApiCredentialPayloadSchema = z.discriminatedUnion("aud", [
  backofficeJwtPayloadSchema,
  installedAppJwtPayloadSchema,
]);
export type BackofficeApiCredentialPayload = z.infer<typeof backofficeApiCredentialPayloadSchema>;

const verifyBackofficeApiCredentialWithJwks: JwtPayloadVerifier<
  BackofficeApiCredentialPayload
> = async (token, resolver) => {
  const verification = await jwtVerify(token, resolver, {
    issuer: ACCESS_TOKEN_ISSUER,
    audience: [ACCESS_TOKEN_AUDIENCE, INSTALLED_APP_ACCESS_TOKEN_AUDIENCE],
  });
  return backofficeApiCredentialPayloadSchema.parse(verification.payload);
};

const verifyAppInstallationCodeWithJwks: JwtPayloadVerifier<AppInstallationCodePayload> = async (
  token,
  resolver,
) => {
  const verification = await jwtVerify(token, resolver, {
    issuer: ACCESS_TOKEN_ISSUER,
    audience: APP_INSTALLATION_CODE_AUDIENCE,
  });
  return appInstallationCodePayloadSchema.parse(verification.payload);
};

export type JwtVerificationResult<TPayload> =
  | { ok: true; payload: TPayload }
  | { ok: false; reason: "missing" | "expired" | "invalid" };

export type BackofficeJwtVerificationResult = JwtVerificationResult<BackofficeJwtPayload>;

/** User and app credentials share Auth's signing keys and therefore one JWKS cache. */
async function verifyWithBackofficeJwks<TPayload>(
  token: string | null,
  requestUrl: string,
  authObject: JwksFetchObject,
  verify: JwtPayloadVerifier<TPayload>,
): Promise<JwtVerificationResult<TPayload>> {
  if (!token) {
    return { ok: false, reason: "missing" };
  }

  const requestOrigin = new URL(requestUrl).origin;
  const cacheAuthority = resolveBackofficeJwksCacheAuthority(authObject, requestOrigin);
  const jwksEntry = await resolveBackofficeJwks(authObject, cacheAuthority, requestOrigin);

  try {
    return {
      ok: true,
      payload: await verify(token, jwksEntry.resolver),
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
    const payload = await verify(token, refreshedEntry.resolver);
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
}

export const verifyBackofficeJwt = async (
  token: string | null,
  requestUrl: string,
  authObject: JwksFetchObject,
): Promise<BackofficeJwtVerificationResult> =>
  await verifyWithBackofficeJwks(token, requestUrl, authObject, verifyBackofficeJwtWithJwks);

export async function verifyInstalledAppJwt(
  token: string | null,
  requestUrl: string,
  authObject: JwksFetchObject,
): Promise<JwtVerificationResult<InstalledAppJwtPayload>> {
  return await verifyWithBackofficeJwks(
    token,
    requestUrl,
    authObject,
    verifyInstalledAppJwtWithJwks,
  );
}

export async function verifyBackofficeApiCredential(
  token: string | null,
  requestUrl: string,
  authObject: JwksFetchObject,
): Promise<JwtVerificationResult<BackofficeApiCredentialPayload>> {
  return await verifyWithBackofficeJwks(
    token,
    requestUrl,
    authObject,
    verifyBackofficeApiCredentialWithJwks,
  );
}

export async function verifyAppInstallationCode(
  code: string,
  requestUrl: string,
  authObject: JwksFetchObject,
): Promise<JwtVerificationResult<AppInstallationCodePayload>> {
  return await verifyWithBackofficeJwks(
    code,
    requestUrl,
    authObject,
    verifyAppInstallationCodeWithJwks,
  );
}

export const verifyBackofficeJwtRequest = async (
  request: Request,
  authObject: JwksFetchObject,
): Promise<BackofficeJwtVerificationResult> =>
  await verifyBackofficeJwt(
    readBackofficeAccessTokenCookie(request.headers.get("cookie")),
    request.url,
    authObject,
  );
