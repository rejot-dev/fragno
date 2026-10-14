import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  backofficeOrganizationIdentity,
  backofficeRouteScopeFromResolvedScope,
  type BackofficeOrganizationIdentity,
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import {
  backofficeRouteScopePath,
  requireBackofficeRouteScopeFromParams,
} from "@/backoffice-runtime/route-scope";
import type { BackofficeMeData } from "@/fragno/auth/contracts";

import type { AutomationProjectRecord } from "./data";
import { toExternalId } from "./data";

export type AutomationScopeKind = "system" | "org" | "project" | "user";

type Organization = BackofficeMeData["organizations"][number]["organization"];

const SYSTEM_AUTOMATION_SCOPE_LABEL = "System";

const userName = (user: BackofficeMeData["user"]) => user.email ?? user.id;
const isAutomationAdmin = (user: BackofficeMeData["user"]) => user.role === "admin";

const projectLabel = (project: AutomationProjectRecord) =>
  project.name?.trim() || project.slug?.trim() || toExternalId(project.id) || "Untitled project";

export const terminalCommandPath = (scope: BackofficeScopeSelection) =>
  `/backoffice/terminal/${backofficeRouteScopePath(backofficeRouteScopeFromResolvedScope(scope))}`;

export function automationRuntimeScopeFromRouteParams(
  params: { scopeKind?: string; scopeId?: string },
  organizations: readonly BackofficeOrganizationIdentity[],
): BackofficeContextScope {
  try {
    const routeScope = requireBackofficeRouteScopeFromParams(params);
    const resolvedScope = resolveBackofficeRouteScope(routeScope, organizations);
    if (!resolvedScope) {
      throw new Response("Not Found", { status: 404 });
    }
    return backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    throw new Response("Not Found", { status: 404 });
  }
}

export const resolveAutomationScopeSelection = ({
  params,
  organizations,
  project,
  user,
}: {
  params: { scopeKind?: string; scopeId?: string };
  organizations: Organization[];
  project: AutomationProjectRecord | null;
  user: BackofficeMeData["user"];
}): BackofficeScopeSelection => {
  let resolvedScope;
  try {
    const routeScope = requireBackofficeRouteScopeFromParams(params);
    resolvedScope = resolveBackofficeRouteScope(routeScope, organizations);
  } catch {
    throw new Response("Not Found", { status: 404 });
  }
  if (!resolvedScope) {
    throw new Response("Not Found", { status: 404 });
  }

  if (resolvedScope.kind === "system") {
    if (!isAutomationAdmin(user)) {
      throw new Response("Not Found", { status: 404 });
    }
    return { kind: "system", label: SYSTEM_AUTOMATION_SCOPE_LABEL };
  }

  if (resolvedScope.kind === "org") {
    const organization = resolvedScope.organization;
    return {
      ...resolvedScope,
      organization: backofficeOrganizationIdentity(organization),
      label: organization.name ?? organization.id,
    };
  }

  if (resolvedScope.kind === "project") {
    const organization = resolvedScope.organization;
    if (!project || toExternalId(project.id) !== resolvedScope.projectId || project.archivedAt) {
      throw new Response("Not Found", { status: 404 });
    }
    return {
      kind: "project",
      organization: backofficeOrganizationIdentity(organization),
      projectId: resolvedScope.projectId,
      label: projectLabel(project),
    };
  }

  if (resolvedScope.kind === "user" && resolvedScope.userId === user.id) {
    return { kind: "user", userId: user.id, label: userName(user) };
  }

  throw new Response("Not Found", { status: 404 });
};
