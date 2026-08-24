import type { RouterContextProvider } from "react-router";

import { resolveBackofficeUserAuthorityRole } from "@/backoffice-runtime/authority-roles";
import {
  createBackofficeUserExecution,
  type BackofficeContextScope,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";

import {
  authorizeBackofficePrincipal,
  requireBackofficePrincipal,
  type BackofficeAuthPrincipal,
} from "./request-auth.server";

const assertAuthenticatedUserCanAccessScope = (
  auth: BackofficeAuthPrincipal,
  scope: BackofficeContextScope,
) => {
  const role = resolveBackofficeUserAuthorityRole(
    {
      userId: auth.user.id,
      role: auth.user.role,
      scope: auth.auth.scope,
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
): BackofficeExecutionContext => {
  assertAuthenticatedUserCanAccessScope(auth, scope);
  return createBackofficeUserExecution({
    scope,
    userId: auth.user.id,
    verifiedRequestAuthority: {
      role: auth.user.role,
      scope: auth.auth.scope,
      expiresAt: auth.auth.expiresAt,
    },
  });
};

export const requireBackofficeContext = async (
  request: Request,
  routerContext: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<BackofficeExecutionContext> => {
  const auth = await requireBackofficePrincipal(request, routerContext);
  return createBackofficeExecutionForPrincipal(auth, scope);
};

export const authorizeBackofficeContext = async (
  request: Request,
  routerContext: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<
  | { ok: true; execution: BackofficeExecutionContext; headers: Array<[string, string]> }
  | { ok: false; response: Response }
> => {
  const authorization = await authorizeBackofficePrincipal(request, routerContext);
  if (!authorization.ok) {
    return authorization;
  }

  try {
    return {
      ok: true,
      execution: createBackofficeExecutionForPrincipal(authorization.principal, scope),
      headers: authorization.headers,
    };
  } catch (error) {
    if (error instanceof BackofficeForbiddenError) {
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
};
