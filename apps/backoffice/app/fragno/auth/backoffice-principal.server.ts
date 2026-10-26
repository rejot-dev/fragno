import {
  type BackofficeContextScope,
  backofficeScopeContains,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import {
  type BackofficeIdentityDirectory,
  resolveAdministeredMember,
} from "@/backoffice-runtime/authority-resolver";
import {
  type BackofficeUserAuthority,
  resolveBackofficeUserAuthorityRole,
} from "@/backoffice-runtime/authority-roles";
import {
  createBackofficeRequestExecution,
  type BackofficeExecutionContext,
  type BackofficeRequestExecution,
} from "@/backoffice-runtime/context";
import { BackofficeForbiddenError, isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { backofficeOrganizationContextScope } from "@/backoffice-runtime/resolved-scope";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { BackofficeAuthPrincipal } from "./contracts";
import { authorizeBackofficePrincipal, requireBackofficePrincipal } from "./request-auth.server";

type AdministeredMemberDirectory = Pick<BackofficeIdentityDirectory, "findAdministeredMember">;

/**
 * Verifies the principal's access to the scope and creates its request execution. Only a scope
 * another user owns asks Auth, once, whether the principal administers that user; the execution
 * carries the answer, so its actions never ask again.
 */
export const createBackofficeExecutionForPrincipal = async (
  auth: BackofficeAuthPrincipal,
  scope: BackofficeContextScope,
  identities: AdministeredMemberDirectory,
): Promise<BackofficeRequestExecution> => {
  if (auth.auth.scopeRestriction && !backofficeScopeContains(auth.auth.scopeRestriction, scope)) {
    throw new BackofficeForbiddenError("Credential scope does not permit the requested scope.");
  }
  const organization = auth.auth.organization;
  const authority: BackofficeUserAuthority = {
    userId: auth.user.id,
    personalScope: auth.user.personalScope,
    role: auth.user.role,
    organization: organization && backofficeOrganizationContextScope(organization),
    administeredMember: await resolveAdministeredMember(identities, auth.user.id, scope),
  };
  if (!resolveBackofficeUserAuthorityRole(authority, scope)) {
    throw new BackofficeForbiddenError(
      scope.kind === "system" ? "System context requires an admin user." : "Forbidden",
    );
  }
  return createBackofficeRequestExecution({
    scope,
    verifiedRequestAuthority: {
      ...authority,
      expiresAt: auth.auth.expiresAt,
      scopeRestriction: auth.auth.scopeRestriction,
    },
  });
};

/** Reads Auth only when a request names another user's personal scope. */
export function routerContextIdentities(
  routerContext: Readonly<RouterContextProvider>,
): AdministeredMemberDirectory {
  return {
    findAdministeredMember: async (input) =>
      await routerContext
        .get(BackofficeWorkerContext)
        .runtime.objects.auth.singleton()
        .commands.findAdministeredMember(input),
  };
}

export const requireBackofficeContext = async (
  request: Request,
  routerContext: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<BackofficeRequestExecution> => {
  const auth = await requireBackofficePrincipal(request, routerContext);
  return await createBackofficeExecutionForPrincipal(
    auth,
    scope,
    routerContextIdentities(routerContext),
  );
};

type BackofficeContextAuthorization =
  | { ok: true; execution: BackofficeExecutionContext; headers: Array<[string, string]> }
  | { ok: false; response: Response };

type AuthorizedBackofficePrincipal = Extract<
  Awaited<ReturnType<typeof authorizeBackofficePrincipal>>,
  { ok: true }
>;

async function authorizePrincipalForBackofficeScope(
  authorization: AuthorizedBackofficePrincipal,
  scope: BackofficeContextScope,
  identities: AdministeredMemberDirectory,
): Promise<BackofficeContextAuthorization> {
  try {
    return {
      ok: true,
      execution: await createBackofficeExecutionForPrincipal(
        authorization.principal,
        scope,
        identities,
      ),
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
    ? await authorizePrincipalForBackofficeScope(
        authorization,
        scope,
        routerContextIdentities(routerContext),
      )
    : authorization;
}
