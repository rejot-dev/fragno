import {
  type BackofficeContextScope,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import {
  getBackofficeShellRequest,
  requireRouteScope,
  requireScopeSelection,
} from "@/layouts/backoffice-shell-request.server";

import { integrationsScopeBasePath } from "./connection-paths";
import {
  type AuthenticatedScopedIntegrationContext,
  integrationBasePath,
  type ScopedIntegrationContext,
} from "./scope";

/** The runtime scope of an integration page, limited to the scope kinds the page supports. */
export function resolveAuthenticatedIntegrationRuntimeScope({
  context,
  allowedScopes,
}: {
  context: Readonly<RouterContextProvider>;
  allowedScopes?: readonly BackofficeContextScope["kind"][];
}): BackofficeContextScope {
  const scope = requireRouteScope(context).execution.scope;
  if (allowedScopes && !allowedScopes.includes(scope.kind)) {
    throw new Response("Not Found", { status: 404 });
  }
  return scope;
}

export function resolveAuthenticatedOrgIntegrationRuntimeScope({
  context,
}: {
  context: Readonly<RouterContextProvider>;
}): Extract<BackofficeContextScope, { kind: "org" }> {
  const scope = resolveAuthenticatedIntegrationRuntimeScope({ context, allowedScopes: ["org"] });
  if (scope.kind !== "org") {
    throw new Response("Not Found", { status: 404 });
  }
  return scope;
}

/** The integration pages of a scoped Backoffice URL, in the scope the shell resolved. */
export const resolveIntegrationContext = ({
  context,
  integration,
  allowedScopes,
}: {
  context: Readonly<RouterContextProvider>;
  integration: string;
  allowedScopes?: readonly BackofficeContextScope["kind"][];
}): ScopedIntegrationContext => {
  const uiScope = requireScopeSelection(context);
  const scope = backofficeRuntimeScopeFromResolvedScope(uiScope);
  if (allowedScopes && !allowedScopes.includes(scope.kind)) {
    throw new Response("Not Found", { status: 404 });
  }

  return {
    scope,
    uiScope,
    label: uiScope.label,
    basePath: integrationBasePath(uiScope, integration),
    integrationsPath: integrationsScopeBasePath(uiScope),
    scopeSegment: backofficeScopePathSegment(scope),
    isScopedRoute: true,
  };
};

export const resolveAuthenticatedIntegrationContext = ({
  context,
  integration,
  allowedScopes,
}: {
  context: Readonly<RouterContextProvider>;
  integration: string;
  allowedScopes?: readonly BackofficeContextScope["kind"][];
}): AuthenticatedScopedIntegrationContext => ({
  ...resolveIntegrationContext({ context, integration, allowedScopes }),
  me: getBackofficeShellRequest(context).me,
});

export const resolveAuthenticatedOrgIntegrationContext = ({
  context,
  integration,
}: {
  context: Readonly<RouterContextProvider>;
  integration: string;
}) => {
  const integrationContext = resolveAuthenticatedIntegrationContext({
    context,
    integration,
    allowedScopes: ["org"],
  });
  if (integrationContext.scope.kind !== "org") {
    throw new Response("Not Found", { status: 404 });
  }

  return {
    integration: integrationContext,
    orgId: integrationContext.scope.orgId,
  };
};
