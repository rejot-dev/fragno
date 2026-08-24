import type { RouterContextProvider } from "react-router";

import {
  BACKOFFICE_AUTH_ERROR_HEADER,
  BACKOFFICE_TOKEN_EXPIRED_CODE,
  backofficeMeDataSchema,
  type BackofficeMeData,
} from "@/fragno/auth/contracts";
import { resolveBackofficeJwtTransport } from "@/fragno/auth/jwt-transport";
import {
  expiredBackofficeAccessTokenCookieHeaders,
  verifyBackofficeJwt,
} from "@/fragno/auth/token-lifecycle";
import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

export const callBetterAuth = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  const origin = request.headers.get("origin") ?? new URL(request.url).origin;
  if (cookie) {
    headers.set("cookie", cookie);
  }
  if (authorization) {
    headers.set("authorization", authorization);
  }
  if (origin) {
    headers.set("origin", origin);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return await getAuthDurableObject(context).fetch(
    new Request(new URL(`/api/auth${path}`, request.url), {
      ...init,
      headers,
      redirect: "manual",
    }),
  );
};

export function createBackofficeIdentityChangeHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  for (const expiredCookie of expiredBackofficeAccessTokenCookieHeaders()) {
    headers.append("Set-Cookie", expiredCookie);
  }
  return headers;
}

export type BackofficeMeLookupResult =
  | { status: "missing" }
  | { status: "invalid"; reason: "expired" | "invalid" }
  | { status: "authenticated"; me: BackofficeMeData; expiresAt: Date };

export async function getBackofficeMe(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<BackofficeMeLookupResult> {
  const transport = resolveBackofficeJwtTransport(request);
  if (!transport.ok) {
    return transport.reason === "missing"
      ? { status: "missing" }
      : { status: "invalid", reason: "invalid" };
  }

  const authObject = getAuthDurableObject(context);
  const verification = await verifyBackofficeJwt(transport.token, request.url, authObject);
  if (!verification.ok) {
    return verification.reason === "missing"
      ? { status: "missing" }
      : { status: "invalid", reason: verification.reason };
  }

  const me = await authObject.getBackofficeMe({
    userId: verification.payload.sub,
    activeOrganizationId:
      verification.payload.scope.kind === "org" || verification.payload.scope.kind === "project"
        ? verification.payload.scope.orgId
        : null,
  });
  return me
    ? {
        status: "authenticated",
        me: backofficeMeDataSchema.parse(me),
        expiresAt: new Date(verification.payload.exp * 1_000),
      }
    : { status: "invalid", reason: "invalid" };
}

export async function findBackofficeMe(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<BackofficeMeData | null> {
  const result = await getBackofficeMe(request, context);
  return result.status === "authenticated" ? result.me : null;
}

export async function requireBackofficeMe(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<BackofficeMeData> {
  const result = await getBackofficeMe(request, context);
  if (result.status === "authenticated") {
    return result.me;
  }
  const expired = result.status === "invalid" && result.reason === "expired";
  throw new Response(expired ? "Authentication expired" : "Authentication required", {
    status: 401,
    headers: expired
      ? { [BACKOFFICE_AUTH_ERROR_HEADER]: BACKOFFICE_TOKEN_EXPIRED_CODE }
      : undefined,
  });
}
