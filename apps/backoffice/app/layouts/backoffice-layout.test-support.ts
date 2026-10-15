import type { RouterContextProvider } from "react-router";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import {
  backofficeOrganizationIdentity,
  backofficeProjectIdentity,
  type BackofficeNamedProject,
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import type {
  BackofficeAuthPrincipal,
  BackofficeMeData,
  Organization,
} from "@/fragno/auth/contracts";

import { establishBackofficeAuthenticatedRequest } from "./backoffice-authenticated-request.server";
import {
  BackofficeShellRequestContext,
  establishBackofficeShellRequest,
} from "./backoffice-shell-request.server";

type BackofficeRouteHandlerArgs = {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: Readonly<Record<string, string | undefined>>;
};

/**
 * Wraps a protected Backoffice loader or action so it runs behind the Backoffice layout
 * middleware, as React Router runs it. Responses thrown by the middleware propagate unchanged.
 */
export function behindBackofficeLayout<TArgs extends BackofficeRouteHandlerArgs, TResult>(
  handler: (args: TArgs) => Promise<TResult> | TResult,
): (args: TArgs) => Promise<TResult> {
  return async (args) => {
    let handled: { result: TResult } | null = null;
    await establishBackofficeAuthenticatedRequest(args, () =>
      establishBackofficeShellRequest(args, async () => {
        handled = { result: await handler(args) };
        return new Response(null);
      }),
    );
    if (!handled) {
      throw new Error("The Backoffice layout middleware did not run the route handler.");
    }
    return (handled as { result: TResult }).result;
  };
}

/**
 * Provides the shell request the Backoffice layout middleware establishes, for unit tests that
 * call a protected handler directly. `routeScope` is null when the URL's scope does not resolve.
 */
export function provideBackofficeShellRequest(
  context: RouterContextProvider,
  input: {
    me: BackofficeMeData;
    routeScope: BackofficeResolvedScope<Organization, BackofficeNamedProject> | null;
  },
): void {
  const { me, routeScope } = input;
  const defaultScope: BackofficeResolvedScope<Organization, BackofficeNamedProject> =
    me.activeOrganization
      ? { kind: "org", organization: me.activeOrganization.organization }
      : { kind: "user", userId: me.user.id };
  const accessTokenExpiresAt = new Date(Date.now() + 60_000);
  context.set(BackofficeShellRequestContext, {
    me,
    principal: {
      user: me.user,
      auth: { scopeRestriction: null, transport: "cookie", expiresAt: accessTokenExpiresAt },
    } as unknown as BackofficeAuthPrincipal,
    resolvedScope: routeScope ?? defaultScope,
    route: routeScope
      ? {
          status: "resolved",
          resolvedScope: routeScope,
          execution: {
            scope: backofficeRuntimeScopeFromResolvedScope(routeScope),
          } as BackofficeExecutionContext,
          selection: selectionOf(routeScope, me),
        }
      : { status: "not-found" },
    accessTokenExpiresAt,
  });
}

function selectionOf(
  scope: BackofficeResolvedScope<Organization, BackofficeNamedProject>,
  me: BackofficeMeData,
): BackofficeScopeSelection {
  switch (scope.kind) {
    case "system":
      return { kind: "system", label: "System" };
    case "org":
      return {
        kind: "org",
        organization: backofficeOrganizationIdentity(scope.organization),
        label: scope.organization.name ?? scope.organization.id,
      };
    case "project":
      return {
        kind: "project",
        owner: {
          kind: "org",
          organization: backofficeOrganizationIdentity(scope.owner.organization),
        },
        project: backofficeProjectIdentity(scope.project),
        label: scope.project.name,
      };
    case "user":
      return { kind: "user", userId: scope.userId, label: me.user.email ?? me.user.id };
    default:
      throw new Error("Backoffice scope kind is unsupported.", { cause: scope satisfies never });
  }
}
