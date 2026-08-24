import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  backofficeResolvedScopeFromRuntimeScope,
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeRouteScopeFromParams } from "@/backoffice-runtime/route-scope";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import type { BackofficeMeData } from "@/fragno/auth/auth-client";
import { findBackofficeMe } from "@/fragno/auth/auth-server";

import type { AutomationProjectRecord } from "../automations/data";
import {
  automationScopeBasePath,
  createAutomationScopeOptions,
  type AutomationScopeOption,
} from "../automations/scope";
import { throwBackofficeOrganizationNotFound } from "../route-errors";

export type IntegrationRouteParams = {
  scopeKind?: string;
  scopeId?: string;
};

export type IntegrationScopeSwitchOption = AutomationScopeOption;

export type ScopedIntegrationContext = {
  scope: BackofficeContextScope;
  uiScope: BackofficeScopeSelection;
  label: string;
  basePath: string;
  integrationsPath: string;
  scopeSegment: string;
  isScopedRoute: boolean;
};

export type AuthenticatedScopedIntegrationContext = ScopedIntegrationContext & {
  me: BackofficeMeData;
};

export const scopeLabel = (scope: BackofficeContextScope, me: BackofficeMeData): string => {
  switch (scope.kind) {
    case "system":
      return "System";
    case "org": {
      const organization = me.organizations.find((entry) => entry.organization.id === scope.orgId);
      return organization?.organization.name ?? scope.orgId;
    }
    case "project":
      return scope.projectId;
    case "user":
      return me.user.id === scope.userId ? (me.user.email ?? me.user.id) : scope.userId;
  }

  throw new Error("Unsupported Backoffice context scope kind.");
};

export function integrationScopeSelectionFromRuntimeScope(
  scope: BackofficeContextScope,
  me: BackofficeMeData,
): BackofficeScopeSelection {
  const organization =
    scope.kind === "org" || scope.kind === "project"
      ? (me.organizations.find((entry) => entry.organization.id === scope.orgId)?.organization ??
        null)
      : null;
  const resolvedScope = backofficeResolvedScopeFromRuntimeScope(scope, organization);
  return { ...resolvedScope, label: scopeLabel(scope, me) };
}

export const integrationBasePath = (scope: BackofficeScopeSelection, integration: string) =>
  `${automationScopeBasePath(scope)}/integrations/${integration}`;

export const organizationIdFromScope = (scope: BackofficeContextScope): string | null =>
  scope.kind === "org" || scope.kind === "project" ? scope.orgId : null;

export const createOrganizationScopeOptions = (organizations: BackofficeMeData["organizations"]) =>
  organizations.map(({ organization }) => ({
    id: organization.id,
    label: organization.name ?? organization.id,
  }));

export const createIntegrationScopeSwitchOptions = ({
  me,
  projects,
  projectOrgId,
  integration,
  allowedScopes,
}: {
  me: BackofficeMeData;
  projects: AutomationProjectRecord[];
  projectOrgId: string;
  integration: string;
  allowedScopes?: readonly BackofficeContextScope["kind"][];
}): IntegrationScopeSwitchOption[] => {
  const scopeOptions = createAutomationScopeOptions({
    organizations: me.organizations.map((entry) => entry.organization),
    projects,
    user: me.user,
    currentTab: "integrations",
    projectOrgId,
  });

  const allowedScopeKinds = allowedScopes ? new Set(allowedScopes) : null;
  return scopeOptions.flatMap((option) =>
    !allowedScopeKinds || allowedScopeKinds.has(option.kind)
      ? [{ ...option, to: `${option.to}/${integration}` }]
      : [],
  );
};

export const resolveIntegrationContext = ({
  params,
  me,
  integration,
  allowedScopes,
}: {
  params: IntegrationRouteParams;
  me: BackofficeMeData;
  integration: string;
  allowedScopes?: readonly BackofficeContextScope["kind"][];
}): ScopedIntegrationContext => {
  const routeScope = requireBackofficeRouteScopeFromParams(params);
  const resolvedScope = resolveBackofficeRouteScope(
    routeScope,
    me.organizations.map(({ organization }) => organization),
  );
  if (!resolvedScope) {
    const organizationSlug =
      routeScope.kind === "org" || routeScope.kind === "project" ? routeScope.orgSlug : undefined;
    throwBackofficeOrganizationNotFound(organizationSlug);
  }
  const scope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const isScopedRoute = true;

  if (allowedScopes && !allowedScopes.includes(scope.kind)) {
    throw new Response("Not Found", { status: 404 });
  }

  if (scope.kind === "system" && me.user.role !== "admin") {
    throw new Response("Not Found", { status: 404 });
  }

  if (scope.kind === "user" && scope.userId !== me.user.id) {
    throw new Response("Not Found", { status: 404 });
  }

  const uiScope = { ...resolvedScope, label: scopeLabel(scope, me) };
  const scopedBasePath = integrationBasePath(uiScope, integration);
  return {
    scope,
    uiScope,
    label: scopeLabel(scope, me),
    basePath: scopedBasePath,
    integrationsPath: `${automationScopeBasePath(uiScope)}/integrations`,
    scopeSegment: backofficeContextScopeSinglePathSegment(scope),
    isScopedRoute,
  };
};

export const resolveAuthenticatedIntegrationContext = async ({
  request,
  context,
  params,
  integration,
  allowedScopes,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: IntegrationRouteParams;
  integration: string;
  allowedScopes?: readonly BackofficeContextScope["kind"][];
}): Promise<AuthenticatedScopedIntegrationContext> => {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw new Response("Not Found", { status: 404 });
  }

  return {
    ...resolveIntegrationContext({ params, me, integration, allowedScopes }),
    me,
  };
};

export const resolveAuthenticatedOrgIntegrationContext = async ({
  request,
  context,
  params,
  integration,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: IntegrationRouteParams;
  integration: string;
}) => {
  const integrationContext = await resolveAuthenticatedIntegrationContext({
    request,
    context,
    params,
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
