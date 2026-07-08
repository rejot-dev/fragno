import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  backofficeContextScopeFromSinglePathSegment,
  backofficeContextScopeSinglePathSegment,
} from "@/backoffice-runtime/scope-codec";
import type { AuthMeData } from "@/fragno/auth/auth-client";
import { getAuthMe } from "@/fragno/auth/auth-server";

import type { AutomationProjectRecord } from "../automations/data";
import {
  automationScopeBasePath,
  automationScopeFromRouteParams,
  createAutomationScopeOptions,
  type AutomationScopeOption,
  type AutomationUiScope,
} from "../automations/scope";
import { throwOrganisationNotFound } from "../route-errors";

export type IntegrationRouteParams = {
  scopeKind?: string;
  scopeId?: string;
};

export type IntegrationScopeSwitchOption = AutomationScopeOption;

export type ScopedIntegrationContext = {
  scope: BackofficeContextScope;
  uiScope: AutomationUiScope;
  label: string;
  basePath: string;
  integrationsPath: string;
  scopeSegment: string;
  isScopedRoute: boolean;
};

export type AuthenticatedScopedIntegrationContext = ScopedIntegrationContext & {
  me: AuthMeData;
};

export const scopeLabel = (scope: BackofficeContextScope, me: AuthMeData): string => {
  switch (scope.kind) {
    case "system":
      return "System";
    case "org": {
      const organisation = me.organizations.find((entry) => entry.organization.id === scope.orgId);
      return organisation?.organization.name ?? scope.orgId;
    }
    case "project":
      return scope.projectId;
    case "user":
      return me.user.id === scope.userId ? (me.user.email ?? me.user.id) : scope.userId;
  }
};

export const scopeToAutomationUiScope = (
  scope: BackofficeContextScope,
  me: AuthMeData,
): AutomationUiScope => {
  switch (scope.kind) {
    case "system":
      return { kind: "system", label: "System" };
    case "org":
      return { kind: "org", orgId: scope.orgId, label: scopeLabel(scope, me) };
    case "project":
      return {
        kind: "project",
        orgId: scope.orgId,
        projectId: scope.projectId,
        label: scope.projectId,
      };
    case "user":
      return { kind: "user", userId: scope.userId, label: scopeLabel(scope, me) };
  }
};

export const integrationBasePath = (scope: AutomationUiScope, integration: string) =>
  `${automationScopeBasePath(scope)}/integrations/${integration}`;

export const organizationIdFromScope = (scope: BackofficeContextScope): string | null =>
  scope.kind === "org" || scope.kind === "project" ? scope.orgId : null;

export const createIntegrationScopeSwitchOptions = ({
  me,
  projects,
  projectOrgId,
  integration,
  allowedScopes,
}: {
  me: AuthMeData;
  projects: AutomationProjectRecord[];
  projectOrgId: string;
  integration: string;
  allowedScopes?: readonly BackofficeContextScope["kind"][];
}): IntegrationScopeSwitchOption[] => {
  const scopeOptions = createAutomationScopeOptions({
    organisations: me.organizations.map((entry) => entry.organization),
    projects,
    user: me.user,
    currentTab: "integrations",
    projectOrgId,
  });

  return scopeOptions
    .filter((option) => !allowedScopes || allowedScopes.includes(option.kind))
    .map((option) => ({
      ...option,
      to: `${option.to}/${integration}`,
    }));
};

export const resolveIntegrationContext = ({
  params,
  me,
  integration,
  allowedScopes,
}: {
  params: IntegrationRouteParams;
  me: AuthMeData;
  integration: string;
  allowedScopes?: readonly BackofficeContextScope["kind"][];
}): ScopedIntegrationContext => {
  const scope = automationScopeFromRouteParams(params);
  const isScopedRoute = true;

  if (allowedScopes && !allowedScopes.includes(scope.kind)) {
    throw new Response("Not Found", { status: 404 });
  }

  if (scope.kind === "system" && me.user.role !== "admin") {
    throw new Response("Not Found", { status: 404 });
  }

  const organizationId = organizationIdFromScope(scope);
  if (
    organizationId &&
    !me.organizations.some((entry) => entry.organization.id === organizationId)
  ) {
    throwOrganisationNotFound(organizationId);
  }

  if (scope.kind === "user" && scope.userId !== me.user.id) {
    throw new Response("Not Found", { status: 404 });
  }

  const uiScope = scopeToAutomationUiScope(scope, me);
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
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw new Response("Not Found", { status: 404 });
  }

  return {
    ...resolveIntegrationContext({ params, me, integration, allowedScopes }),
    me,
  };
};

export const resolveScopeFromRouteParams = (
  params: IntegrationRouteParams,
): BackofficeContextScope => {
  if (params.scopeKind && params.scopeId) {
    return automationScopeFromRouteParams(params);
  }

  throw new Response("Not Found", { status: 404 });
};

export const resolveOrganizationScopeFromRouteParams = (
  params: IntegrationRouteParams,
): { scope: Extract<BackofficeContextScope, { kind: "org" }>; organizationId: string } => {
  const scope = resolveScopeFromRouteParams(params);
  if (scope.kind !== "org") {
    throw new Response("Not Found", { status: 404 });
  }
  return { scope, organizationId: scope.orgId };
};

export const resolveScopeFromSinglePathOrOrg = (segment: string): BackofficeContextScope => {
  try {
    return backofficeContextScopeFromSinglePathSegment(segment);
  } catch {
    return { kind: "org", orgId: segment };
  }
};
