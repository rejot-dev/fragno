import {
  createContext,
  redirect,
  type RouterContext,
  type RouterContextProvider,
} from "react-router";

import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { isBackofficeScopeCodecError } from "@/backoffice-runtime/scope-codec";
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

import { getBackofficeAuthenticatedRequest } from "./backoffice-authenticated-request.server";
import { resolveCurrentBackofficeScope } from "./backoffice-layout-scope";

/** Contains authenticated scope and authority established before Backoffice route handlers. */
export type BackofficeShellRequest = {
  me: BackofficeMeData;
  principal: BackofficeAuthPrincipal;
  resolvedScope: BackofficeResolvedScope<Organization>;
  runtimeScope: BackofficeContextScope;
  execution: BackofficeExecutionContext;
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
  let resolvedScope: BackofficeResolvedScope<Organization>;
  try {
    resolvedScope = resolveCurrentBackofficeScope({
      params,
      defaultScope,
      organizations: me.organizations.map(({ organization }) => organization),
    });
  } catch (error) {
    if (!isBackofficeScopeCodecError(error)) {
      throw error;
    }
    resolvedScope = defaultScope;
  }

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
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  let execution: BackofficeExecutionContext;
  try {
    execution = createBackofficeExecutionForPrincipal(principal, runtimeScope);
  } catch (error) {
    if (error instanceof BackofficeForbiddenError) {
      throw new Response(error.message, { status: 403 });
    }
    throw error;
  }

  context.set(BackofficeShellRequestContext, {
    me,
    principal,
    resolvedScope,
    runtimeScope,
    execution,
    accessTokenExpiresAt: authenticatedRequest.accessTokenExpiresAt,
  });
  return await next();
}

/** Reads authenticated scope guaranteed by the Backoffice layout middleware chain. */
export function getBackofficeShellRequest(
  context: Readonly<RouterContextProvider>,
): BackofficeShellRequest {
  return context.get(BackofficeShellRequestContext);
}
