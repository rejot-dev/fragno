import type { BackofficeContextScope } from "@/backoffice-runtime/context";
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

export type AutomationScopeOption = {
  id: string;
  kind: AutomationScopeKind;
  label: string;
  description: string;
  to: string;
};

type Organization = BackofficeMeData["organizations"][number]["organization"];

const SYSTEM_AUTOMATION_SCOPE_ID = "system";
const SYSTEM_AUTOMATION_SCOPE_LABEL = "System";

const userName = (user: BackofficeMeData["user"]) => user.email ?? user.id;
const isAutomationAdmin = (user: BackofficeMeData["user"]) => user.role === "admin";

const projectLabel = (project: AutomationProjectRecord) =>
  project.name?.trim() || project.slug?.trim() || toExternalId(project.id) || "Untitled project";

export const automationScopeBasePath = (scope: BackofficeScopeSelection) =>
  `/backoffice/automations/${backofficeRouteScopePath(
    backofficeRouteScopeFromResolvedScope(scope),
  )}`;

type AutomationScopeTab =
  | "dashboard"
  | "scripts"
  | "router"
  | "store"
  | "api"
  | "events"
  | "events-catalog"
  | "integrations"
  | "mcp"
  | "sandboxes";

const SYSTEM_UNAVAILABLE_AUTOMATION_TABS = new Set<AutomationScopeTab>(["api", "mcp", "sandboxes"]);

export const resolveAutomationScopeTab = (
  scope: BackofficeScopeSelection,
  requestedTab: AutomationScopeTab,
) =>
  scope.kind === "system" && SYSTEM_UNAVAILABLE_AUTOMATION_TABS.has(requestedTab)
    ? "scripts"
    : requestedTab;

export const automationScopeTabPath = (
  scope: BackofficeScopeSelection,
  tab: AutomationScopeTab = "dashboard",
) => `${automationScopeBasePath(scope)}/${tab}`;

export const automationScopeTerminalCommandPath = (scope: BackofficeScopeSelection) =>
  `${automationScopeBasePath(scope)}/terminal-command`;

export const createAutomationScopeOptions = ({
  organizations,
  projects,
  user,
  currentTab,
  projectOrgId,
  pathForScope,
}: {
  organizations: Organization[];
  projects: AutomationProjectRecord[];
  user: BackofficeMeData["user"];
  currentTab: AutomationScopeTab;
  projectOrgId: string | null;
  pathForScope?: (scope: BackofficeScopeSelection) => string;
}): AutomationScopeOption[] => {
  const destinationFor = (scope: BackofficeScopeSelection) =>
    pathForScope?.(scope) ??
    automationScopeTabPath(scope, resolveAutomationScopeTab(scope, currentTab));
  const orgOptions = organizations.map((organization) => ({
    id: `org:${organization.id}`,
    kind: "org" as const,
    label: organization.name ?? organization.id,
    description: "Organization scope",
    to: destinationFor({
      kind: "org",
      organization: backofficeOrganizationIdentity(organization),
      label: organization.name ?? organization.id,
    }),
  }));

  const projectOrganization = projectOrgId
    ? (organizations.find((organization) => organization.id === projectOrgId) ?? null)
    : null;
  const projectOptions = projects.flatMap((project) => {
    if (!projectOrganization || project.archivedAt) {
      return [];
    }

    const projectId = toExternalId(project.id);
    const option = {
      id: `project:${projectOrgId}:${projectId}`,
      kind: "project" as const,
      label: projectLabel(project),
      description: project.slug?.trim() ? `Project · ${project.slug}` : "Project scope",
      to: destinationFor({
        kind: "project",
        organization: backofficeOrganizationIdentity(projectOrganization),
        projectId,
        label: projectLabel(project),
      }),
    };

    return option.to.includes("/project/") ? [option] : [];
  });

  const userScope = { kind: "user" as const, userId: user.id, label: userName(user) };
  const systemScope = { kind: "system" as const, label: SYSTEM_AUTOMATION_SCOPE_LABEL };
  const systemOptions: AutomationScopeOption[] = isAutomationAdmin(user)
    ? [
        {
          id: `system:${SYSTEM_AUTOMATION_SCOPE_ID}`,
          kind: "system",
          label: SYSTEM_AUTOMATION_SCOPE_LABEL,
          description: "Global system automation scope",
          to: destinationFor(systemScope),
        },
      ]
    : [];

  return [
    ...systemOptions,
    ...orgOptions,
    ...projectOptions,
    {
      id: `user:${user.id}`,
      kind: "user",
      label: userName(user),
      description: "Personal user scope",
      to: destinationFor(userScope),
    },
  ];
};

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
