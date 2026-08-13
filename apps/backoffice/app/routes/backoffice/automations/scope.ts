import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  backofficeContextScopeFromRouteParams,
  backofficeContextScopeRoutePath,
} from "@/backoffice-runtime/scope-codec";
import type { AuthMeData } from "@/fragno/auth/auth-client";

import type { AutomationProjectRecord } from "./data";
import { toExternalId } from "./data";

export type AutomationScopeKind = "system" | "org" | "project" | "user";

export type AutomationUiScope =
  | { kind: "system"; label: string }
  | { kind: "org"; orgId: string; label: string }
  | { kind: "project"; orgId: string; projectId: string; label: string }
  | { kind: "user"; userId: string; label: string };

type Organisation = AuthMeData["organizations"][number]["organization"];

const SYSTEM_AUTOMATION_SCOPE_LABEL = "System";

const userName = (user: AuthMeData["user"]) => user.email ?? user.id;
const isAutomationAdmin = (user: AuthMeData["user"]) => user.role === "admin";

const projectLabel = (project: AutomationProjectRecord) =>
  project.name?.trim() || project.slug?.trim() || toExternalId(project.id) || "Untitled project";

export const toBackofficeScope = (scope: AutomationUiScope): BackofficeContextScope => {
  switch (scope.kind) {
    case "system":
      return { kind: "system" };
    case "org":
      return { kind: "org", orgId: scope.orgId };
    case "project":
      return { kind: "project", orgId: scope.orgId, projectId: scope.projectId };
    case "user":
      return { kind: "user", userId: scope.userId };
  }

  throw new Error("Unsupported automation UI scope kind.");
};

export const automationScopeBasePath = (scope: AutomationUiScope) =>
  `/backoffice/automations/${backofficeContextScopeRoutePath(toBackofficeScope(scope))}`;

export const automationUiScopeId = (scope: AutomationUiScope) => {
  switch (scope.kind) {
    case "system":
      return "system:system";
    case "org":
      return `org:${scope.orgId}`;
    case "project":
      return `project:${scope.orgId}:${scope.projectId}`;
    case "user":
      return `user:${scope.userId}`;
  }

  throw new Error("Unsupported automation UI scope kind.");
};

export type AutomationScopeTab =
  | "dashboard"
  | "terminal"
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
  scope: AutomationUiScope,
  requestedTab: AutomationScopeTab,
) =>
  scope.kind === "system" && SYSTEM_UNAVAILABLE_AUTOMATION_TABS.has(requestedTab)
    ? "scripts"
    : requestedTab;

export const automationScopeTabPath = (
  scope: AutomationUiScope,
  tab: AutomationScopeTab = "dashboard",
) => `${automationScopeBasePath(scope)}/${tab}`;

export const automationScopeFromRouteParams = (params: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeContextScope => {
  try {
    const scope = backofficeContextScopeFromRouteParams(params);
    if (!scope) {
      throw new Response("Not Found", { status: 404 });
    }
    return scope;
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    throw new Response("Not Found", { status: 404 });
  }
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
  let parsed;
  try {
    parsed = backofficeContextScopeFromRouteParams(params);
  } catch {
    throw new Response("Not Found", { status: 404 });
  }

  if (parsed?.kind === "system") {
    if (!isAutomationAdmin(user)) {
      throw new Response("Not Found", { status: 404 });
    }
    return { kind: "system", label: SYSTEM_AUTOMATION_SCOPE_LABEL };
  }

  if (parsed?.kind === "org") {
    const organisation = organisations.find((entry) => entry.id === parsed.orgId);
    if (!organisation) {
      throw new Response("Not Found", { status: 404 });
    }
    return { kind: "org", orgId: organisation.id, label: organisation.name ?? organisation.id };
  }

  if (parsed?.kind === "project") {
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

  if (parsed?.kind === "user" && parsed.userId === user.id) {
    return { kind: "user", userId: user.id, label: userName(user) };
  }

  throw new Response("Not Found", { status: 404 });
};
