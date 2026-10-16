import { backofficeScopeOrganization } from "@fragno-dev/backoffice-api/v0/shared/scope";
import {
  createContext,
  redirect,
  type RouterContext,
  type RouterContextProvider,
} from "react-router";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import {
  backofficeOrganizationIdentity,
  backofficeProjectIdentity,
  type BackofficeNamedProject,
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
  type BackofficeRoutableScopeSelection,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { createBackofficeExecutionForPrincipal } from "@/fragno/auth/backoffice-principal.server";
import type {
  BackofficeAuthPrincipal,
  BackofficeMeData,
  Organization,
} from "@/fragno/auth/contracts";
import { requireBackofficePrincipal } from "@/fragno/auth/request-auth.server";
import {
  buildBackofficeAuthBootstrapPath,
  buildBackofficeOrganizationSwitchPath,
} from "@/routes/backoffice/auth-navigation";
import { lookupAutomationProject, toExternalId } from "@/routes/backoffice/automations/data.server";
import {
  isBackofficeSystemAdministrator,
  projectScopeLabel,
  SYSTEM_SCOPE_LABEL,
  userScopeLabel,
} from "@/routes/backoffice/scope-labels";

import { getBackofficeAuthenticatedRequest } from "./backoffice-authenticated-request.server";
import { resolveBackofficePageScope } from "./backoffice-layout-scope";

type BackofficePageResolvedScope = BackofficeResolvedScope<Organization, BackofficeNamedProject>;

/**
 * The route's own scope: its URL scope, or the default scope on routes without one. Sections
 * require it, so a URL scope that does not resolve is their 404 or 502 rather than the shell's.
 */
type BackofficeRouteScope =
  | {
      status: "resolved";
      resolvedScope: BackofficePageResolvedScope;
      execution: BackofficeExecutionContext;
      selection: BackofficeScopeSelection;
    }
  | { status: "not-found" }
  | { status: "unavailable"; message: string };

/** Contains authenticated scope and authority established before Backoffice route handlers. */
export type BackofficeShellRequest = {
  me: BackofficeMeData;
  principal: BackofficeAuthPrincipal;
  /** The scope the shell renders: the route's own, or the default when the route's does not resolve. */
  resolvedScope: BackofficePageResolvedScope;
  route: BackofficeRouteScope;
  accessTokenExpiresAt: Date;
};

const backofficeShellRequestContextKey = Symbol.for("fragno.backoffice.shell-request-context");

/** Provides the authenticated shell scope established by Backoffice layout middleware. */
export const BackofficeShellRequestContext = ((globalThis as Record<symbol, unknown>)[
  backofficeShellRequestContextKey
] ??= createContext<BackofficeShellRequest>()) as RouterContext<BackofficeShellRequest>;

type BackofficeShellMiddlewareArgs = {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: {
    scopeKind?: string;
    scopeId?: string;
    orgSlug?: string;
  };
};

/** Establishes the canonical authenticated scope before protected descendant route handlers run. */
export async function establishBackofficeShellRequest(
  { request, context, params }: BackofficeShellMiddlewareArgs,
  next: () => Promise<Response>,
): Promise<Response> {
  const authenticatedRequest = getBackofficeAuthenticatedRequest(context);
  const { me } = authenticatedRequest;
  const returnToUrl = new URL(request.url);
  const returnTo = `${returnToUrl.pathname}${returnToUrl.search}`;
  const activeOrganization = me.activeOrganization?.organization ?? null;
  if (
    me.activeOrganizationId &&
    (!activeOrganization || activeOrganization.id !== me.activeOrganizationId)
  ) {
    throw redirect(buildBackofficeAuthBootstrapPath(returnTo));
  }

  const defaultScope: BackofficePageResolvedScope = activeOrganization
    ? { kind: "org", organization: activeOrganization }
    : { kind: "user", userId: me.user.id };
  // Throwing here would replace the whole layout; sections report the 502 from their loaders.
  let projectLookupFailure = null as string | null;
  const pageScope = await resolveBackofficePageScope({
    params,
    organizations: me.organizations.map(({ organization }) => organization),
    findProject: async (organization, slug): Promise<BackofficeNamedProject | null> => {
      const lookup = await lookupAutomationProject(context, organization.id, { slug });
      if (lookup.status === "error") {
        projectLookupFailure = lookup.message;
        return null;
      }
      // An archived project is no longer a workspace.
      if (lookup.status === "not-found" || lookup.project.archivedAt) {
        return null;
      }
      return { id: toExternalId(lookup.project.id), slug, name: projectScopeLabel(lookup.project) };
    },
  });
  let routeScope: BackofficePageResolvedScope | null;
  switch (pageScope.status) {
    case "resolved":
      routeScope = pageScope.scope;
      break;
    case "absent":
      routeScope = defaultScope;
      break;
    case "invalid":
    case "organization-not-found":
    case "project-not-found":
      routeScope = null;
      break;
    default:
      throw new Error("Unsupported Backoffice page scope status.", {
        cause: pageScope satisfies never,
      });
  }
  // Administrators may act in any user's scope, but sections show only the user's own, and they
  // hide System scope from everyone else rather than refusing it.
  if (
    (routeScope?.kind === "user" && routeScope.userId !== me.user.id) ||
    (routeScope?.kind === "system" && !isBackofficeSystemAdministrator(me.user))
  ) {
    routeScope = null;
  }
  const resolvedScope = routeScope ?? defaultScope;

  const destinationOrganizationId =
    backofficeScopeOrganization(resolvedScope)?.organization.id ?? null;
  if (
    destinationOrganizationId &&
    destinationOrganizationId !== me.activeOrganizationId &&
    me.organizations.some(({ organization }) => organization.id === destinationOrganizationId)
  ) {
    throw redirect(buildBackofficeOrganizationSwitchPath(destinationOrganizationId, returnTo));
  }

  const principal = await requireBackofficePrincipal(request, context);
  let route: BackofficeRouteScope = projectLookupFailure
    ? { status: "unavailable", message: projectLookupFailure }
    : { status: "not-found" };
  if (routeScope) {
    let execution: BackofficeExecutionContext;
    try {
      execution = createBackofficeExecutionForPrincipal(
        principal,
        backofficeRuntimeScopeFromResolvedScope(routeScope),
      );
    } catch (error) {
      if (isBackofficeForbiddenError(error)) {
        throw new Response(error.message, { status: 403 });
      }
      throw error;
    }
    route = {
      status: "resolved",
      resolvedScope: routeScope,
      execution,
      selection: scopeSelectionOf(routeScope, me.user),
    };
  }

  context.set(BackofficeShellRequestContext, {
    me,
    principal,
    resolvedScope,
    route,
    accessTokenExpiresAt: authenticatedRequest.accessTokenExpiresAt,
  });
  return await next();
}

function scopeSelectionOf(
  scope: BackofficePageResolvedScope,
  user: BackofficeMeData["user"],
): BackofficeScopeSelection {
  switch (scope.kind) {
    // The route's execution established that System scope belongs to an administrator.
    case "system":
      return { kind: "system", label: SYSTEM_SCOPE_LABEL };
    case "org":
      return {
        kind: "org",
        organization: backofficeOrganizationIdentity(scope.organization),
        label: scope.organization.name ?? scope.organization.id,
      };
    case "project":
      return {
        kind: "project",
        organization: backofficeOrganizationIdentity(scope.organization),
        project: backofficeProjectIdentity(scope.project),
        label: scope.project.name,
      };
    case "user":
      return { kind: "user", userId: user.id, label: userScopeLabel(user) };
    default:
      throw new Error("Backoffice scope kind is unsupported.", { cause: scope satisfies never });
  }
}

function requireResolvedRoute(context: Readonly<RouterContextProvider>) {
  const { route } = getBackofficeShellRequest(context);
  switch (route.status) {
    case "resolved":
      return route;
    case "not-found":
      throw new Response("Not Found", { status: 404 });
    case "unavailable":
      throw new Response(route.message, { status: 502 });
    default:
      throw new Error("Backoffice route scope is unsupported.", { cause: route satisfies never });
  }
}

/**
 * The route's own scope with its label, or the section's 404 or 502. Thrown from a section loader,
 * the response renders in that section's error boundary inside the shell.
 */
export function requireScopeSelection(
  context: Readonly<RouterContextProvider>,
): BackofficeScopeSelection {
  return requireResolvedRoute(context).selection;
}

/** The route's own scope for sections that have no System scope. */
export function requireRoutableScopeSelection(
  context: Readonly<RouterContextProvider>,
): BackofficeRoutableScopeSelection {
  const selection = requireScopeSelection(context);
  if (selection.kind === "system") {
    throw new Response("Not Found", { status: 404 });
  }
  return selection;
}

/** The route's own scope and the authority to act in it. */
export function requireRouteScope(context: Readonly<RouterContextProvider>): {
  resolvedScope: BackofficePageResolvedScope;
  execution: BackofficeExecutionContext;
} {
  const { resolvedScope, execution } = requireResolvedRoute(context);
  return { resolvedScope, execution };
}

/** Reads authenticated scope guaranteed by the Backoffice layout middleware chain. */
export function getBackofficeShellRequest(
  context: Readonly<RouterContextProvider>,
): BackofficeShellRequest {
  return context.get(BackofficeShellRequestContext);
}
