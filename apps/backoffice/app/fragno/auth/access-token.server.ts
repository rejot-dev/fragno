import type { RouterContextProvider } from "react-router";

import { createAuthAccessTokenMethods, type AuthPrincipal } from "@fragno-dev/auth";

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  backofficeAccessTokenContextSchema,
  resolveLiveAccessTokenSecret,
  type BackofficeAccessTokenContext,
} from "@/fragno/auth/auth";
import { getAuthDurableObject } from "@/worker-runtime/durable-objects";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

const parseBackofficeAccessTokenContext = (value: unknown): BackofficeAccessTokenContext | null => {
  const parsed = backofficeAccessTokenContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export type BackofficeAuthPrincipal = AuthPrincipal & {
  auth: AuthPrincipal["auth"] & { sessionContext: BackofficeAccessTokenContext };
};

const getBackofficeAccessTokenMethods = (context: Readonly<RouterContextProvider>) => {
  const { env } = context.get(BackofficeWorkerContext);

  return createAuthAccessTokenMethods({
    authentication: {
      accessTokens: {
        enabled: true,
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        secret: resolveLiveAccessTokenSecret(env, import.meta.env.MODE === "development"),
        expiresInSeconds: 15 * 60,
        issueCookie: true,
        acceptBearer: false,
        context: {
          schema: backofficeAccessTokenContextSchema,
          project: () => ({ organizationIds: [] }),
        },
      },
    },
  });
};

const getSetCookieHeaders = (headers: Headers): string[] =>
  (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
  (headers.get("Set-Cookie") ? [headers.get("Set-Cookie")!] : []);

const refreshAccessTokenForRequest = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<{ principal: BackofficeAuthPrincipal; headers: Array<[string, string]> } | null> => {
  const cookie = request.headers.get("cookie");
  if (!cookie) {
    return null;
  }

  const refreshUrl = new URL("/api/auth/token/refresh", request.url);
  const refreshResponse = await getAuthDurableObject(context).fetch(
    new Request(refreshUrl, {
      method: "POST",
      headers: new Headers({
        cookie,
        "content-type": "application/json",
      }),
      body: "{}",
      redirect: "manual",
    }),
  );

  if (!refreshResponse.ok) {
    return null;
  }

  const body = (await refreshResponse.clone().json()) as { auth?: { token?: unknown } };
  const token = body.auth?.token;
  if (typeof token !== "string") {
    throw new Error("Auth token refresh response did not include an access token.");
  }

  const verification = await getBackofficeAccessTokenMethods(context).verify({
    token,
    source: "cookie",
  });
  if (!verification.ok) {
    throw new Error("Auth token refresh response included an invalid access token.");
  }

  return {
    principal: verification.principal as BackofficeAuthPrincipal,
    headers: getSetCookieHeaders(refreshResponse.headers).map((value) => ["Set-Cookie", value]),
  };
};

const resolveAuthPrincipal = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<
  | { ok: true; principal: BackofficeAuthPrincipal; headers: Array<[string, string]> }
  | { ok: false; reason: "missing" | "malformed" | "multiple" | "expired" | "invalid" | "disabled" }
> => {
  const verification = await getBackofficeAccessTokenMethods(context).verifyRequest({
    headers: request.headers,
  });
  if (verification.ok) {
    return { ok: true, principal: verification.principal as BackofficeAuthPrincipal, headers: [] };
  }

  if (verification.reason !== "malformed" && verification.reason !== "multiple") {
    const refreshed = await refreshAccessTokenForRequest(request, context);
    if (refreshed) {
      return { ok: true, ...refreshed };
    }
  }

  return verification;
};

export const getAuthPrincipal = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<BackofficeAuthPrincipal | null> => {
  const result = await resolveAuthPrincipal(request, context);
  return result.ok ? result.principal : null;
};

export const requireAuthPrincipal = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<BackofficeAuthPrincipal> => {
  const auth = await resolveAuthPrincipal(request, context);

  if (auth.ok === false) {
    throw new Response(
      auth.reason === "malformed"
        ? "Malformed authentication"
        : auth.reason === "multiple"
          ? "Multiple authentication credentials"
          : auth.reason === "missing"
            ? "Authentication required"
            : auth.reason === "expired"
              ? "Authentication expired"
              : "Invalid credential",
      { status: 401 },
    );
  }

  return auth.principal;
};

export const requireOrganizationAccess = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<BackofficeAuthPrincipal> => {
  const principal = await requireAuthPrincipal(request, context);
  const tokenContext = parseBackofficeAccessTokenContext(principal.auth.sessionContext);
  if (!tokenContext?.organizationIds.includes(orgId)) {
    throw new Response("Forbidden", { status: 403 });
  }

  return principal;
};

export const authorizeAccessTokenForOrganization = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<{ ok: true; headers: Array<[string, string]> } | { ok: false; response: Response }> => {
  try {
    const auth = await resolveAuthPrincipal(request, context);
    if (!auth.ok) {
      return {
        ok: false,
        response: new Response(
          auth.reason === "malformed"
            ? "Malformed authentication"
            : auth.reason === "multiple"
              ? "Multiple authentication credentials"
              : auth.reason === "missing"
                ? "Authentication required"
                : auth.reason === "expired"
                  ? "Authentication expired"
                  : "Invalid credential",
          { status: 401 },
        ),
      };
    }

    const tokenContext = parseBackofficeAccessTokenContext(auth.principal.auth.sessionContext);
    if (!tokenContext?.organizationIds.includes(orgId)) {
      return { ok: false, response: new Response("Forbidden", { status: 403 }) };
    }

    return { ok: true, headers: auth.headers };
  } catch (error) {
    if (error instanceof Response) {
      return { ok: false, response: error };
    }
    throw error;
  }
};
