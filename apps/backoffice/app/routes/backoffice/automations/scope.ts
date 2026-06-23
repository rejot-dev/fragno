import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { AuthMeData } from "@/fragno/auth/auth-client";

import type { AutomationProjectRecord } from "./data";
import { toExternalId } from "./data";

export type AutomationScopeKind = "org" | "project" | "user";

export type AutomationUiScope =
  | { kind: "org"; orgId: string; label: string }
  | { kind: "project"; orgId: string; projectId: string; label: string }
  | { kind: "user"; userId: string; label: string };

export type AutomationScopeOption = {
  id: string;
  kind: AutomationScopeKind;
  label: string;
  description: string;
  to: string;
};

type Organisation = AuthMeData["organizations"][number]["organization"];

const userName = (user: AuthMeData["user"]) => user.email ?? user.id;

const projectLabel = (project: AutomationProjectRecord) =>
  project.name?.trim() || project.slug?.trim() || toExternalId(project.id) || "Untitled project";

export const toBackofficeScope = (scope: AutomationUiScope): BackofficeContextScope => {
  switch (scope.kind) {
    case "org":
      return { kind: "org", orgId: scope.orgId };
    case "project":
      return { kind: "project", orgId: scope.orgId, projectId: scope.projectId };
    case "user":
      return { kind: "user", userId: scope.userId };
  }
};

const projectScopeId = (orgId: string, projectId: string) => `${orgId}~${projectId}`;

const parseProjectScopeId = (scopeId: string) => {
  const [orgId, ...projectIdParts] = scopeId.split("~");
  const projectId = projectIdParts.join("~");
  return orgId && projectId ? { orgId, projectId } : null;
};

export const automationScopeBasePath = (scope: AutomationUiScope) => {
  switch (scope.kind) {
    case "org":
      return `/backoffice/automations/org/${encodeURIComponent(scope.orgId)}`;
    case "project":
      return `/backoffice/automations/project/${encodeURIComponent(projectScopeId(scope.orgId, scope.projectId))}`;
    case "user":
      return `/backoffice/automations/user/${encodeURIComponent(scope.userId)}`;
  }
};

export const automationScopeTabPath = (
  scope: AutomationUiScope,
  tab: "scripts" | "store" = "scripts",
) => `${automationScopeBasePath(scope)}/${tab}`;

export const createAutomationScopeOptions = ({
  organisations,
  projects,
  user,
  currentTab,
  projectOrgId,
}: {
  organisations: Organisation[];
  projects: AutomationProjectRecord[];
  user: AuthMeData["user"];
  currentTab: "scripts" | "store";
  projectOrgId: string;
}): AutomationScopeOption[] => {
  const orgOptions = organisations.map((organisation) => ({
    id: `org:${organisation.id}`,
    kind: "org" as const,
    label: organisation.name ?? organisation.id,
    description: "Organisation scope",
    to: automationScopeTabPath(
      { kind: "org", orgId: organisation.id, label: organisation.name ?? organisation.id },
      currentTab,
    ),
  }));

  const projectOptions = projects
    .filter((project) => !project.archivedAt)
    .map((project) => {
      const projectId = toExternalId(project.id);
      return {
        id: `project:${projectId}`,
        kind: "project" as const,
        label: projectLabel(project),
        description: project.slug?.trim() ? `Project · ${project.slug}` : "Project scope",
        to: automationScopeTabPath(
          {
            kind: "project",
            orgId: projectOrgId,
            projectId,
            label: projectLabel(project),
          },
          currentTab,
        ),
      };
    })
    .filter((option) => option.to.includes("/project/"));

  const userScope = { kind: "user" as const, userId: user.id, label: userName(user) };

  return [
    ...orgOptions,
    ...projectOptions,
    {
      id: `user:${user.id}`,
      kind: "user",
      label: userName(user),
      description: "Personal user scope",
      to: automationScopeTabPath(userScope, currentTab),
    },
  ];
};

export const automationScopeFromRouteParams = (params: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeContextScope => {
  if (params.scopeKind === "org" && params.scopeId) {
    return { kind: "org", orgId: params.scopeId };
  }
  if (params.scopeKind === "project" && params.scopeId) {
    const parsed = parseProjectScopeId(params.scopeId);
    if (parsed) {
      return { kind: "project", orgId: parsed.orgId, projectId: parsed.projectId };
    }
  }
  if (params.scopeKind === "user" && params.scopeId) {
    return { kind: "user", userId: params.scopeId };
  }
  throw new Response("Not Found", { status: 404 });
};

export const resolveAutomationUiScope = ({
  params,
  organisations,
  projects,
  user,
}: {
  params: { scopeKind?: string; scopeId?: string };
  organisations: Organisation[];
  projects: AutomationProjectRecord[];
  user: AuthMeData["user"];
}): AutomationUiScope => {
  const scopeKind = params.scopeKind;
  const scopeId = params.scopeId;

  if (scopeKind === "org" && scopeId) {
    const organisation = organisations.find((entry) => entry.id === scopeId);
    if (!organisation) {
      throw new Response("Not Found", { status: 404 });
    }
    return { kind: "org", orgId: organisation.id, label: organisation.name ?? organisation.id };
  }

  if (scopeKind === "project" && scopeId) {
    const parsed = parseProjectScopeId(scopeId);
    if (!parsed) {
      throw new Response("Not Found", { status: 404 });
    }
    const organisation = organisations.find((entry) => entry.id === parsed.orgId);
    if (!organisation) {
      throw new Response("Not Found", { status: 404 });
    }
    const project = projects.find((entry) => toExternalId(entry.id) === parsed.projectId);
    if (!project || project.archivedAt) {
      throw new Response("Not Found", { status: 404 });
    }
    return {
      kind: "project",
      orgId: organisation.id,
      projectId: parsed.projectId,
      label: projectLabel(project),
    };
  }

  if (scopeKind === "user" && scopeId === user.id) {
    return { kind: "user", userId: user.id, label: userName(user) };
  }

  throw new Response("Not Found", { status: 404 });
};
