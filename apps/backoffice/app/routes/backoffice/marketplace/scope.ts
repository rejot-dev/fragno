import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import {
  backofficeScopeFromRouteParams,
  backofficeScopeRouteId,
} from "@/backoffice-runtime/scope-codec";
import type { AuthMeData } from "@/fragno/auth/auth-client";

import type { AutomationProjectRecord } from "../automations/data";
import { toExternalId } from "../automations/data";

export type MarketplaceTab = "marketplace" | "installed" | "my-listings";

export type MarketplaceUiScope =
  | { kind: "org"; orgId: string; label: string }
  | { kind: "project"; orgId: string; projectId: string; label: string }
  | { kind: "user"; userId: string; label: string };

export type MarketplaceScopeOption = {
  id: string;
  kind: MarketplaceUiScope["kind"];
  label: string;
  description: string;
  to: string;
};

type Organisation = AuthMeData["organizations"][number]["organization"];

const userName = (user: AuthMeData["user"]) => user.email ?? user.id;

const projectLabel = (project: AutomationProjectRecord) =>
  project.name?.trim() || project.slug?.trim() || toExternalId(project.id) || "Untitled project";

export const toMarketplaceTargetScope = (scope: MarketplaceUiScope): BackofficeRoutableScope => {
  switch (scope.kind) {
    case "org":
      return { kind: "org", orgId: scope.orgId };
    case "project":
      return { kind: "project", orgId: scope.orgId, projectId: scope.projectId };
    case "user":
      return { kind: "user", userId: scope.userId };
    default: {
      const unsupportedScope: never = scope;
      throw new Error(`Unsupported Marketplace scope: ${String(unsupportedScope)}`);
    }
  }
};

export const marketplaceScopeBasePath = (scope: MarketplaceUiScope) =>
  `/backoffice/marketplace/${scope.kind}/${backofficeScopeRouteId(toMarketplaceTargetScope(scope))}`;

export const marketplaceScopeTabPath = (
  scope: MarketplaceUiScope,
  tab: MarketplaceTab = "marketplace",
) => `${marketplaceScopeBasePath(scope)}/${tab}`;

const marketplaceScopeSwitchPath = ({
  destinationScope,
  selectedScope,
  pathname,
  search,
}: {
  destinationScope: MarketplaceUiScope;
  selectedScope: MarketplaceUiScope;
  pathname: string;
  search: string;
}) => {
  const selectedScopeBasePath = marketplaceScopeBasePath(selectedScope);
  const nestedPath = pathname.startsWith(`${selectedScopeBasePath}/`)
    ? pathname.slice(selectedScopeBasePath.length)
    : "/marketplace";

  return `${marketplaceScopeBasePath(destinationScope)}${nestedPath}${search}`;
};

export const marketplaceScopeFromRouteParams = (params: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeRoutableScope => {
  try {
    const scope = backofficeScopeFromRouteParams(params);
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

export const resolveMarketplaceUiScope = ({
  params,
  organisations,
  projects,
  user,
}: {
  params: { scopeKind?: string; scopeId?: string };
  organisations: Organisation[];
  projects: AutomationProjectRecord[];
  user: AuthMeData["user"];
}): MarketplaceUiScope => {
  const parsed = marketplaceScopeFromRouteParams(params);

  if (parsed.kind === "org") {
    const organisation = organisations.find((entry) => entry.id === parsed.orgId);
    if (!organisation) {
      throw new Response("Not Found", { status: 404 });
    }
    return { kind: "org", orgId: organisation.id, label: organisation.name ?? organisation.id };
  }

  if (parsed.kind === "project") {
    const organisation = organisations.find((entry) => entry.id === parsed.orgId);
    const project = projects.find((entry) => toExternalId(entry.id) === parsed.projectId);
    if (!organisation || !project || project.archivedAt) {
      throw new Response("Not Found", { status: 404 });
    }
    return {
      kind: "project",
      orgId: organisation.id,
      projectId: parsed.projectId,
      label: projectLabel(project),
    };
  }

  if (parsed.userId !== user.id) {
    throw new Response("Not Found", { status: 404 });
  }
  return { kind: "user", userId: user.id, label: userName(user) };
};

export const createMarketplaceScopeOptions = ({
  organisations,
  projects,
  user,
  selectedScope,
  currentLocation,
  projectOrgId,
}: {
  organisations: Organisation[];
  projects: AutomationProjectRecord[];
  user: AuthMeData["user"];
  selectedScope: MarketplaceUiScope;
  currentLocation: { pathname: string; search: string };
  projectOrgId: string | null;
}): MarketplaceScopeOption[] => {
  const organizationOptions = organisations.map((organisation) => {
    const scope: MarketplaceUiScope = {
      kind: "org",
      orgId: organisation.id,
      label: organisation.name ?? organisation.id,
    };
    return {
      id: `org:${organisation.id}`,
      kind: "org" as const,
      label: scope.label,
      description: "Organisation workspace",
      to: marketplaceScopeSwitchPath({
        destinationScope: scope,
        selectedScope,
        ...currentLocation,
      }),
    };
  });

  const projectOptions = projectOrgId
    ? projects.flatMap((project) => {
        if (project.archivedAt) {
          return [];
        }
        const projectId = toExternalId(project.id);
        const scope: MarketplaceUiScope = {
          kind: "project",
          orgId: projectOrgId,
          projectId,
          label: projectLabel(project),
        };
        return [
          {
            id: `project:${projectId}`,
            kind: "project" as const,
            label: scope.label,
            description: project.slug?.trim() ? `Project · ${project.slug}` : "Project workspace",
            to: marketplaceScopeSwitchPath({
              destinationScope: scope,
              selectedScope,
              ...currentLocation,
            }),
          },
        ];
      })
    : [];

  const userScope: MarketplaceUiScope = {
    kind: "user",
    userId: user.id,
    label: userName(user),
  };

  return [
    ...organizationOptions,
    ...projectOptions,
    {
      id: `user:${user.id}`,
      kind: "user",
      label: userScope.label,
      description: "Personal workspace",
      to: marketplaceScopeSwitchPath({
        destinationScope: userScope,
        selectedScope,
        ...currentLocation,
      }),
    },
  ];
};
