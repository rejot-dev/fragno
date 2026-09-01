import type { RouterContextProvider } from "react-router";

import {
  BACKOFFICE_AUTH_ERROR_HEADER,
  BACKOFFICE_TOKEN_EXPIRED_CODE,
  type BackofficeAuthPrincipal,
} from "@/fragno/auth/contracts";
import {
  getBackofficeRequestState,
  type BackofficeAuthenticationFailureReason,
} from "@/worker-runtime/request-state";

export type { BackofficeAuthPrincipal } from "@/fragno/auth/contracts";

function authFailureResponse(
  reason: BackofficeAuthenticationFailureReason,
  headers: Array<[string, string]>,
): Response {
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
}

export async function requireBackofficePrincipal(
  _request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<BackofficeAuthPrincipal> {
  const authentication = await getBackofficeRequestState(context).getPrincipal();
  if (!authentication.ok) {
    throw authFailureResponse(authentication.reason, authentication.headers);
  }
  return authentication.principal;
}

export async function authorizeBackofficePrincipal(
  _request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<
  | { ok: true; principal: BackofficeAuthPrincipal; headers: Array<[string, string]> }
  | { ok: false; response: Response }
> {
  const authentication = await getBackofficeRequestState(context).getPrincipal();
  return authentication.ok
    ? authentication
    : {
        ok: false,
        response: authFailureResponse(authentication.reason, authentication.headers),
      };
}
