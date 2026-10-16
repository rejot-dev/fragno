import { isBackofficeScopeParseError } from "@fragno-dev/backoffice-api/v0/shared/scope";
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
import { toExternalId } from "@/routes/backoffice/automations/data";
import { lookupAutomationProject } from "@/routes/backoffice/automations/data.server";
import {
  isBackofficeSystemAdministrator,
  projectScopeLabel,
  SYSTEM_SCOPE_LABEL,
  userScopeLabel,
} from "@/routes/backoffice/scope-labels";

import { getBackofficeAuthenticatedRequest } from "./backoffice-authenticated-request.server";
import { resolveCurrentBackofficeScope } from "./backoffice-layout-scope";

/** Whether the route's own scope can be shown; sections turn the outcome into their response. */
type BackofficeScopeSelectionResult =
  | { status: "selected"; selection: BackofficeScopeSelection }
  | { status: "not-found" }
  | { status: "unavailable"; message: string };

/**
 * The route's own scope: its URL scope, or the default scope on routes without one. Sections
 * require it, so a URL scope that does not resolve is their 404 rather than the shell's.
 */
type BackofficeRouteScope =
  | {
      status: "resolved";
      resolvedScope: BackofficeResolvedScope<Organization>;
      execution: BackofficeExecutionContext;
      /** Selects the scope on first call, looking up a project scope's project once. */
      selectScope: () => Promise<BackofficeScopeSelectionResult>;
    }
  | { status: "not-found" };

/** Contains authenticated scope and authority established before Backoffice route handlers. */
export type BackofficeShellRequest = {
  me: BackofficeMeData;
  principal: BackofficeAuthPrincipal;
  /** The scope the shell renders: the route's own, or the default when the route's does not resolve. */
  resolvedScope: BackofficeResolvedScope<Organization>;
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

  const defaultScope: BackofficeResolvedScope<Organization> = activeOrganization
    ? { kind: "org", organization: activeOrganization }
    : { kind: "user", userId: me.user.id };
  let routeScope: BackofficeResolvedScope<Organization> | null;
  try {
    routeScope = resolveCurrentBackofficeScope({
      params,
      defaultScope,
      organizations: me.organizations.map(({ organization }) => organization),
    });
  } catch (error) {
    if (!isBackofficeScopeParseError(error)) {
      throw error;
    }
    // Throwing here would replace the whole layout; sections report the 404 from their loaders.
    routeScope = null;
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
    resolvedScope.kind === "org" || resolvedScope.kind === "project"
      ? resolvedScope.organization.id
      : null;
  if (
    destinationOrganizationId &&
    destinationOrganizationId !== me.activeOrganizationId &&
    me.organizations.some(({ organization }) => organization.id === destinationOrganizationId)
  ) {
    throw redirect(buildBackofficeOrganizationSwitchPath(destinationOrganizationId, returnTo));
  }

  const principal = await requireBackofficePrincipal(request, context);
  let route: BackofficeRouteScope = { status: "not-found" };
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
    let scopeSelection: Promise<BackofficeScopeSelectionResult> | null = null;
    route = {
      status: "resolved",
      resolvedScope: routeScope,
      execution,
      selectScope: () => (scopeSelection ??= selectRouteScope(context, routeScope, me.user)),
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

async function selectRouteScope(
  context: Readonly<RouterContextProvider>,
  scope: BackofficeResolvedScope<Organization>,
  user: BackofficeMeData["user"],
): Promise<BackofficeScopeSelectionResult> {
  switch (scope.kind) {
    // The route's execution established that System scope belongs to an administrator.
    case "system":
      return { status: "selected", selection: { kind: "system", label: SYSTEM_SCOPE_LABEL } };
    case "org":
      return {
        status: "selected",
        selection: {
          kind: "org",
          organization: backofficeOrganizationIdentity(scope.organization),
          label: scope.organization.name ?? scope.organization.id,
        },
      };
    case "project": {
      const lookup = await lookupAutomationProject(context, scope.organization.id, scope.projectId);
      if (lookup.status === "error") {
        return { status: "unavailable", message: lookup.message };
      }
      if (
        lookup.status === "not-found" ||
        toExternalId(lookup.project.id) !== scope.projectId ||
        lookup.project.archivedAt
      ) {
        return { status: "not-found" };
      }
      return {
        status: "selected",
        selection: {
          kind: "project",
          organization: backofficeOrganizationIdentity(scope.organization),
          projectId: scope.projectId,
          label: projectScopeLabel(lookup.project),
        },
      };
    }
    case "user":
      return {
        status: "selected",
        selection: { kind: "user", userId: user.id, label: userScopeLabel(user) },
      };
    default:
      throw new Error("Backoffice scope kind is unsupported.", { cause: scope satisfies never });
  }
}

/**
 * The route's own scope with its label, or the section's 404 or 502. Thrown from a section loader,
 * the response renders in that section's error boundary inside the shell.
 */
export async function requireScopeSelection(
  context: Readonly<RouterContextProvider>,
): Promise<BackofficeScopeSelection> {
  const { route } = getBackofficeShellRequest(context);
  if (route.status === "not-found") {
    throw new Response("Not Found", { status: 404 });
  }
  const result = await route.selectScope();
  switch (result.status) {
    case "selected":
      return result.selection;
    case "not-found":
      throw new Response("Not Found", { status: 404 });
    case "unavailable":
      throw new Response(result.message, { status: 502 });
    default:
      throw new Error("Backoffice scope selection is unsupported.", {
        cause: result satisfies never,
      });
  }
}

/** The route's own scope for sections that have no System scope. */
export async function requireRoutableScopeSelection(
  context: Readonly<RouterContextProvider>,
): Promise<BackofficeRoutableScopeSelection> {
  const selection = await requireScopeSelection(context);
  if (selection.kind === "system") {
    throw new Response("Not Found", { status: 404 });
  }
  return selection;
}

/**
 * The route's own scope and the authority to act in it, without looking up a project scope's
 * project. Use {@link requireScopeSelection} when the project must exist.
 */
export function requireRouteScope(context: Readonly<RouterContextProvider>): {
  resolvedScope: BackofficeResolvedScope<Organization>;
  execution: BackofficeExecutionContext;
} {
  const { route } = getBackofficeShellRequest(context);
  if (route.status === "not-found") {
    throw new Response("Not Found", { status: 404 });
  }
  return { resolvedScope: route.resolvedScope, execution: route.execution };
}

/** Reads authenticated scope guaranteed by the Backoffice layout middleware chain. */
export function getBackofficeShellRequest(
  context: Readonly<RouterContextProvider>,
): BackofficeShellRequest {
  return context.get(BackofficeShellRequestContext);
}
