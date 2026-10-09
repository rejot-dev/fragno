import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import { resolveBackofficeUserAuthorityRole } from "@/backoffice-runtime/authority-roles";
import {
  createBackofficeRequestExecution,
  backofficeScopeContains,
  type BackofficeExecutionContext,
  type BackofficeRequestExecution,
} from "@/backoffice-runtime/context";
import { BackofficeForbiddenError, isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";

import type { BackofficeAuthPrincipal } from "./contracts";
import { authorizeBackofficePrincipal, requireBackofficePrincipal } from "./request-auth.server";

const assertAuthenticatedUserCanAccessScope = (
  auth: BackofficeAuthPrincipal,
  scope: BackofficeContextScope,
) => {
  if (auth.auth.scopeRestriction && !backofficeScopeContains(auth.auth.scopeRestriction, scope)) {
    throw new BackofficeForbiddenError("Credential scope does not permit the requested scope.");
  }
  const role = resolveBackofficeUserAuthorityRole(
    {
      userId: auth.user.id,
      role: auth.user.role,
      organizationId: auth.auth.organization?.id ?? null,
    },
    scope,
  );
  if (role) {
    return;
  }

  throw new BackofficeForbiddenError(
    scope.kind === "system" ? "System context requires an admin user." : "Forbidden",
  );
};

export const createBackofficeExecutionForPrincipal = (
  auth: BackofficeAuthPrincipal,
  scope: BackofficeContextScope,
): BackofficeRequestExecution => {
  assertAuthenticatedUserCanAccessScope(auth, scope);
  return createBackofficeRequestExecution({
    scope,
    userId: auth.user.id,
    verifiedRequestAuthority: {
      role: auth.user.role,
      organizationId: auth.auth.organization?.id ?? null,
      expiresAt: auth.auth.expiresAt,
      scopeRestriction: auth.auth.scopeRestriction,
    },
  });
};

export const requireBackofficeContext = async (
  request: Request,
  routerContext: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<BackofficeRequestExecution> => {
  const auth = await requireBackofficePrincipal(request, routerContext);
  return createBackofficeExecutionForPrincipal(auth, scope);
};

type BackofficeContextAuthorization =
  | { ok: true; execution: BackofficeExecutionContext; headers: Array<[string, string]> }
  | { ok: false; response: Response };

type AuthorizedBackofficePrincipal = Extract<
  Awaited<ReturnType<typeof authorizeBackofficePrincipal>>,
  { ok: true }
>;

function authorizePrincipalForBackofficeScope(
  authorization: AuthorizedBackofficePrincipal,
  scope: BackofficeContextScope,
): BackofficeContextAuthorization {
  try {
    return {
      ok: true,
      execution: createBackofficeExecutionForPrincipal(authorization.principal, scope),
      headers: authorization.headers,
    };
  } catch (error) {
    if (isBackofficeForbiddenError(error)) {
      return {
        ok: false,
        response: new Response(error.message, {
          status: 403,
          headers: authorization.headers,
        }),
      };
    }
    throw error;
  }
}

export async function authorizeBackofficeContext(
  request: Request,
  routerContext: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<BackofficeContextAuthorization> {
  const authorization = await authorizeBackofficePrincipal(request, routerContext);
  return authorization.ok
    ? authorizePrincipalForBackofficeScope(authorization, scope)
    : authorization;
}
