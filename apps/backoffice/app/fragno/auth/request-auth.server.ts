import type { RouterContextProvider } from "react-router";

import {
  BACKOFFICE_AUTH_ERROR_HEADER,
  BACKOFFICE_TOKEN_EXPIRED_CODE,
  type BackofficeAuthPrincipal,
} from "@/fragno/auth/contracts";
import { resolveBackofficeJwtTransport } from "@/fragno/auth/jwt-transport";
import {
  expiredBackofficeAccessTokenCookieHeaders,
  verifyBackofficeJwt,
  type BackofficeJwtPayload,
} from "@/fragno/auth/token-lifecycle";
import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

export type { BackofficeAuthPrincipal } from "@/fragno/auth/contracts";

type AuthFailureReason = "missing" | "expired" | "invalid";

const principalFromBackofficeJwt = (
  payload: BackofficeJwtPayload,
  transport: "bearer" | "cookie",
): BackofficeAuthPrincipal => ({
  user: { id: payload.sub, email: payload.email, role: payload.globalRole },
  auth: {
    transport,
    expiresAt: new Date(payload.exp * 1_000),
    organization: payload.organization,
  },
});

const resolveBackofficePrincipal = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<
  | { ok: true; principal: BackofficeAuthPrincipal; headers: Array<[string, string]> }
  | { ok: false; reason: AuthFailureReason; headers: Array<[string, string]> }
> => {
  const transport = resolveBackofficeJwtTransport(request);
  if (!transport.ok) {
    return { ...transport, headers: [] };
  }

  const verification = await verifyBackofficeJwt(
    transport.token,
    request.url,
    getAuthDurableObject(context).http,
  );
  if (!verification.ok) {
    return {
      ok: false,
      reason: verification.reason,
      headers:
        transport.transport === "cookie"
          ? expiredBackofficeAccessTokenCookieHeaders().map((value) => ["Set-Cookie", value])
          : [],
    };
  }

  return {
    ok: true,
    principal: principalFromBackofficeJwt(verification.payload, transport.transport),
    headers: [],
  };
};

const authFailureResponse = (reason: AuthFailureReason, headers: Array<[string, string]>) => {
  const responseHeaders = new Headers(headers);
  if (reason === "expired") {
    responseHeaders.set(BACKOFFICE_AUTH_ERROR_HEADER, BACKOFFICE_TOKEN_EXPIRED_CODE);
  }
  return new Response(
    reason === "missing"
      ? "Authentication required"
      : reason === "expired"
        ? "Authentication expired"
        : "Invalid credential",
    { status: 401, headers: responseHeaders },
  );
};

export const requireBackofficePrincipal = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<BackofficeAuthPrincipal> => {
  const authentication = await resolveBackofficePrincipal(request, context);
  if (!authentication.ok) {
    throw authFailureResponse(authentication.reason, authentication.headers);
  }
  return authentication.principal;
};

export const authorizeBackofficePrincipal = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<
  | { ok: true; principal: BackofficeAuthPrincipal; headers: Array<[string, string]> }
  | { ok: false; response: Response }
> => {
  const authentication = await resolveBackofficePrincipal(request, context);
  return authentication.ok
    ? authentication
    : {
        ok: false,
        response: authFailureResponse(authentication.reason, authentication.headers),
      };
};
