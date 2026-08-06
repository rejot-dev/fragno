import type { RouterContextProvider } from "react-router";

import { resolveBackofficeUserAuthorityRole } from "@/backoffice-runtime/authority-roles";
import {
  createBackofficeUserExecution,
  type BackofficeContextScope,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";

import {
  authorizeAuthPrincipal,
  requireAuthPrincipal,
  type BackofficeAuthPrincipal,
} from "./access-token.server";

const assertAuthenticatedUserCanAccessScope = (
  auth: BackofficeAuthPrincipal,
  scope: BackofficeContextScope,
) => {
  const role = resolveBackofficeUserAuthorityRole(
    {
      userId: auth.user.id,
      role: auth.user.role,
      organizationIds: auth.auth.sessionContext.organizationIds,
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
  if (auth.auth.credentialKind !== "jwt" || !auth.auth.expiresAt) {
    throw new Error("Backoffice execution requires a verified access-token credential.");
  }

  return createBackofficeUserExecution({
    scope,
    userId: auth.user.id,
    verifiedAccessToken: {
      role: auth.user.role,
      organizationIds: auth.auth.sessionContext.organizationIds,
      expiresAt: auth.auth.expiresAt,
    },
  });
};

export const requireBackofficeContext = async (
  request: Request,
  routerContext: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<BackofficeExecutionContext> => {
  const auth = await requireAuthPrincipal(request, routerContext);
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
  const authorization = await authorizeAuthPrincipal(request, routerContext);
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
      return { ok: false, response: new Response(error.message, { status: 403 }) };
    }
    throw error;
  }
};
