import { SignJWT, errors as joseErrors, jwtVerify } from "jose";

import { parseCookies, resolveAuthCookieName, type CookieOptions } from "../utils/cookie";
import {
  hasMultipleRequestCredentials,
  parseBearerToken,
  resolveRequestCredential,
  resolveRequestCredentialCandidates,
} from "./request-auth";
import type {
  AuthCredentialSource,
  AuthPrincipal,
  IssuedAuthCredential,
  ValidatedCredential,
} from "./types";

export interface AuthSessionSnapshot<TSessionContext = unknown> {
  session: {
    id: string;
    expiresAt: Date | null;
    activeOrganizationId: string | null;
    context: TSessionContext;
  };
  user: ValidatedCredential["user"];
  organizationIds: string[];
}

interface StandardSchemaLike<T> {
  "~standard": {
    validate: (
      value: unknown,
    ) =>
      | { value: T; issues?: undefined }
      | { issues: readonly unknown[]; value?: undefined }
      | Promise<
          { value: T; issues?: undefined } | { issues: readonly unknown[]; value?: undefined }
        >;
  };
}

export interface SessionAccessTokenConfig<
  TSessionContext = unknown,
  TAccessTokenContext = unknown,
> {
  enabled?: boolean;
  issuer: string;
  audience: string;
  secret: string;
  expiresInSeconds?: number;
  acceptBearer?: boolean;
  issueCookie?: boolean;
  context?: {
    schema: StandardSchemaLike<TAccessTokenContext>;
    project: (input: {
      snapshot: AuthSessionSnapshot<TSessionContext>;
    }) => TAccessTokenContext | null;
    maxBytes?: number;
  };
}

export const ACCESS_TOKEN_TYPE = "fragno-auth-session-access";
export const resolveRefreshCookieName = (cookieOptions?: CookieOptions): string =>
  `${resolveAuthCookieName(cookieOptions)}_refresh`;
export const REFRESH_COOKIE_NAME = resolveRefreshCookieName();

const encoder = new TextEncoder();

export type ResolvedSessionAccessTokenConfig = Omit<
  Required<SessionAccessTokenConfig>,
  "context"
> & {
  context?: NonNullable<SessionAccessTokenConfig["context"]> & { maxBytes: number };
};

const parseWithStandardSchema = async <T>(
  schema: StandardSchemaLike<T>,
  value: unknown,
): Promise<T> => {
  const result = await schema["~standard"].validate(value);
  if ("issues" in result && result.issues) {
    throw new Error("Invalid access token context");
  }
  return result.value;
};

export const resolveAccessTokenConfig = (
  config?: SessionAccessTokenConfig,
): ResolvedSessionAccessTokenConfig | null => {
  if (!config?.enabled) {
    return null;
  }
  const issueCookie = config.issueCookie !== false;
  const acceptBearer = config.acceptBearer !== false;
  if (!issueCookie && !acceptBearer) {
    throw new Error("Auth access tokens require at least one transport");
  }
  if (!config.issuer || !config.audience || !config.secret) {
    throw new Error("Auth access tokens require issuer, audience, and secret");
  }
  return {
    enabled: true,
    issuer: config.issuer,
    audience: config.audience,
    secret: config.secret,
    expiresInSeconds: config.expiresInSeconds ?? 15 * 60,
    acceptBearer,
    issueCookie,
    ...(config.context
      ? {
          context: {
            ...config.context,
            maxBytes: config.context.maxBytes ?? 1024,
          },
        }
      : {}),
  };
};

export type IssuedSessionAccessTokenCredential = IssuedAuthCredential & {
  kind: "jwt";
  expiresAt: Date;
  refreshToken: string;
};

export const mintSessionAccessToken = async (input: {
  config: ResolvedSessionAccessTokenConfig;
  session: ValidatedCredential;
}): Promise<IssuedSessionAccessTokenCredential> => {
  const now = Math.floor(Date.now() / 1000);
  const sessionExp = input.session.expiresAt
    ? Math.floor(input.session.expiresAt.getTime() / 1000)
    : now + input.config.expiresInSeconds;
  const exp = Math.min(now + input.config.expiresInSeconds, sessionExp);
  const payload: Record<string, unknown> = {
    typ: ACCESS_TOKEN_TYPE,
    sid: input.session.id,
    email: input.session.user.email,
    role: input.session.user.role,
    aorg: input.session.activeOrganizationId,
  };

  if (input.config.context) {
    const projected = input.config.context.project({
      snapshot: {
        session: {
          id: input.session.id,
          expiresAt: input.session.expiresAt,
          activeOrganizationId: input.session.activeOrganizationId,
          context: input.session.sessionContext ?? {},
        },
        user: input.session.user,
        organizationIds: input.session.organizationIds ?? [],
      },
    });
    if (projected !== null) {
      if (projected === undefined) {
        throw new Error("Access token context projector must return a value or null");
      }
      const ctx = await parseWithStandardSchema(input.config.context.schema, projected);
      const size = encoder.encode(JSON.stringify(ctx)).byteLength;
      if (size > input.config.context.maxBytes) {
        throw new Error("Access token context exceeds maxBytes");
      }
      payload["ctx"] = ctx;
    }
  }

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(input.config.issuer)
    .setAudience(input.config.audience)
    .setSubject(input.session.user.id)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(crypto.randomUUID())
    .sign(encoder.encode(input.config.secret));

  return {
    token,
    kind: "jwt",
    expiresAt: new Date(exp * 1000),
    activeOrganizationId: input.session.activeOrganizationId,
    refreshToken: input.session.id,
    refreshExpiresAt: input.session.expiresAt,
  };
};

export const issueSessionBackedAuthCredential = async (input: {
  accessTokens: ResolvedSessionAccessTokenConfig | null;
  session: ValidatedCredential;
}): Promise<IssuedAuthCredential> => {
  if (input.accessTokens) {
    return mintSessionAccessToken({ config: input.accessTokens, session: input.session });
  }

  return {
    token: input.session.id,
    kind: "session",
    expiresAt: input.session.expiresAt,
    activeOrganizationId: input.session.activeOrganizationId,
  };
};

export type VerifySessionAccessTokenResult =
  | { ok: true; principal: AuthPrincipal }
  | { ok: false; reason: "expired" | "invalid" };

export const verifySessionAccessTokenDetailed = async (input: {
  config: ResolvedSessionAccessTokenConfig;
  token: string;
  source: AuthCredentialSource;
}): Promise<VerifySessionAccessTokenResult> => {
  try {
    const { payload } = await jwtVerify(input.token, encoder.encode(input.config.secret), {
      issuer: input.config.issuer,
      audience: input.config.audience,
    });
    const role = payload["role"];
    if (
      payload["typ"] !== ACCESS_TOKEN_TYPE ||
      typeof payload.sub !== "string" ||
      typeof payload["sid"] !== "string" ||
      typeof payload["email"] !== "string" ||
      (role !== "user" && role !== "admin") ||
      typeof payload.exp !== "number"
    ) {
      return { ok: false, reason: "invalid" };
    }
    const sessionContext =
      input.config.context && payload["ctx"] !== undefined
        ? await parseWithStandardSchema(input.config.context.schema, payload["ctx"])
        : {};
    return {
      ok: true,
      principal: {
        user: { id: payload.sub, email: payload["email"], role },
        auth: {
          strategy: "session",
          credentialKind: "jwt",
          credentialSource: input.source,
          credentialId: payload["sid"],
          expiresAt: new Date(payload.exp * 1000),
          activeOrganizationId: typeof payload["aorg"] === "string" ? payload["aorg"] : null,
          sessionContext,
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof joseErrors.JWTExpired ? "expired" : "invalid",
    };
  }
};

export const verifySessionAccessToken = async (input: {
  config: ResolvedSessionAccessTokenConfig;
  token: string;
  source: AuthCredentialSource;
}): Promise<AuthPrincipal | null> => {
  const result = await verifySessionAccessTokenDetailed(input);
  return result.ok ? result.principal : null;
};

export const resolveBackingSessionCredential = async (input: {
  headers: Headers;
  cookieOptions?: CookieOptions;
  accessTokens: ResolvedSessionAccessTokenConfig | null;
}): Promise<
  | { ok: true; credential: { token: string; source: AuthCredentialSource } }
  | { ok: false; reason: "missing" | "malformed" | "multiple" | "invalid" }
> => {
  if (!input.accessTokens) {
    return resolveRequestCredential(input.headers, input.cookieOptions);
  }

  if (hasMultipleRequestCredentials(input.headers, input.cookieOptions)) {
    return { ok: false, reason: "multiple" };
  }

  let sawAccessCredential = false;
  let sawMalformedBearer = false;
  const bearer = parseBearerToken(input.headers.get("Authorization"));
  if (!bearer.ok && bearer.reason === "malformed") {
    sawMalformedBearer = true;
  }

  for (const credential of resolveRequestCredentialCandidates(input.headers, input.cookieOptions)) {
    sawAccessCredential = true;
    if (credential.source === "authorization-header" && !input.accessTokens.acceptBearer) {
      continue;
    }
    if (credential.source === "cookie" && !input.accessTokens.issueCookie) {
      continue;
    }

    const principal = await verifySessionAccessToken({
      config: input.accessTokens,
      token: credential.token,
      source: credential.source,
    });
    if (principal?.auth.credentialId) {
      return {
        ok: true,
        credential: {
          token: principal.auth.credentialId,
          source: credential.source,
        },
      };
    }
  }

  const refreshCredential = resolveRefreshCredential(input.headers, input.cookieOptions, {
    acceptBearer: false,
    issueCookie: input.accessTokens.issueCookie,
  });
  if (refreshCredential.ok) {
    return refreshCredential;
  }

  if (sawAccessCredential) {
    return { ok: false, reason: "invalid" };
  }
  if (sawMalformedBearer) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: false, reason: "missing" };
};

export const resolveRefreshCredential = (
  headers: Headers,
  cookieOptions?: CookieOptions,
  options?: { acceptBearer?: boolean; issueCookie?: boolean },
) => {
  const bearerHeader = headers.get("Authorization");
  if (options?.issueCookie !== false) {
    const cookies = parseCookies(headers.get("Cookie"));
    const cookieName = resolveRefreshCookieName(cookieOptions);
    const cookieToken = cookies[cookieName] ?? cookies[REFRESH_COOKIE_NAME];
    if (cookieToken) {
      if (bearerHeader !== null) {
        return { ok: false as const, reason: "multiple" as const };
      }
      return { ok: true as const, credential: { token: cookieToken, source: "cookie" as const } };
    }
  }

  const bearer = parseBearerToken(bearerHeader);
  if (!bearer.ok && bearer.reason === "malformed") {
    return { ok: false as const, reason: "malformed" as const };
  }
  if (bearer.ok) {
    if (options?.acceptBearer === false) {
      return { ok: false as const, reason: "missing" as const };
    }
    return {
      ok: true as const,
      credential: { token: bearer.token, source: "authorization-header" as const },
    };
  }
  return { ok: false as const, reason: "missing" as const };
};
