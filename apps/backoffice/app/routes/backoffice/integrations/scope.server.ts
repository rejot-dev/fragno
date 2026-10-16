import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import { requireBackofficeRouteScopeFromParams } from "@/backoffice-runtime/route-scope";
import { requireBackofficePrincipal } from "@/fragno/auth/request-auth.server";
import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";

import {
  resolveIntegrationContext,
  type AuthenticatedScopedIntegrationContext,
  type IntegrationRouteParams,
} from "./scope";

/** Resolves a public integration route to an ID-backed scope using JWT authority only. */
export async function resolveAuthenticatedIntegrationRuntimeScope({
  request,
  context,
  params,
  allowedScopes,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: IntegrationRouteParams;
  allowedScopes?: readonly BackofficeContextScope["kind"][];
}): Promise<BackofficeContextScope> {
  const principal = await requireBackofficePrincipal(request, context);
  const routeScope = requireBackofficeRouteScopeFromParams(params);

  if (allowedScopes && !allowedScopes.includes(routeScope.kind)) {
    throw new Response("Not Found", { status: 404 });
  }

  switch (routeScope.kind) {
    case "system":
      if (principal.user.role !== "admin") {
        throw new Response("Not Found", { status: 404 });
      }
      return { kind: "system" };
    case "user":
      if (routeScope.userId !== principal.user.id) {
        throw new Response("Not Found", { status: 404 });
      }
      return { kind: "user", userId: principal.user.id };
    case "org": {
      const organization = principal.auth.organization;
      if (!organization || organization.slug !== routeScope.orgSlug) {
        throw new Response("Not Found", { status: 404 });
      }
      return { kind: "org", orgId: organization.id };
    }
    case "project": {
      const organization = principal.auth.organization;
      if (!organization || organization.slug !== routeScope.orgSlug) {
        throw new Response("Not Found", { status: 404 });
      }
      return { kind: "project", orgId: organization.id, projectId: routeScope.projectId };
    }
  }

  routeScope satisfies never;
  throw new Error("Integration runtime scope received an unsupported route scope kind.");
}

export async function resolveAuthenticatedOrgIntegrationRuntimeScope({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: IntegrationRouteParams;
}): Promise<Extract<BackofficeContextScope, { kind: "org" }>> {
  const scope = await resolveAuthenticatedIntegrationRuntimeScope({
    request,
    context,
    params,
    allowedScopes: ["org"],
  });
  if (scope.kind !== "org") {
    throw new Response("Not Found", { status: 404 });
  }
  return scope;
}

export const resolveAuthenticatedIntegrationContext = async ({
  context,
  params,
  integration,
  allowedScopes,
}: {
  context: Readonly<RouterContextProvider>;
  params: IntegrationRouteParams;
  integration: string;
  allowedScopes?: readonly BackofficeContextScope["kind"][];
}): Promise<AuthenticatedScopedIntegrationContext> => {
  const { me } = getBackofficeShellRequest(context);

  return {
    ...resolveIntegrationContext({ params, me, integration, allowedScopes }),
    me,
  };
};

export const resolveAuthenticatedOrgIntegrationContext = async ({
  context,
  params,
  integration,
}: {
  context: Readonly<RouterContextProvider>;
  params: IntegrationRouteParams;
  integration: string;
}) => {
  const integrationContext = await resolveAuthenticatedIntegrationContext({
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
