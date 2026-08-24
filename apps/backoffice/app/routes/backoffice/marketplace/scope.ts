import {
  backofficeOrganizationIdentity,
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
  type BackofficeRoutableScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import {
  backofficeRouteScopePath,
  requireBackofficeRouteScopeFromParams,
} from "@/backoffice-runtime/route-scope";
import type { BackofficeMeData } from "@/fragno/auth/contracts";

import type { AutomationProjectRecord } from "../automations/data";
import { toExternalId } from "../automations/data";

export type MarketplaceTab = "marketplace" | "installed" | "my-listings";

export type MarketplaceScopeOption = {
  id: string;
  kind: BackofficeRoutableScopeSelection["kind"];
  label: string;
  description: string;
  to: string;
};

type Organization = BackofficeMeData["organizations"][number]["organization"];

const userName = (user: BackofficeMeData["user"]) => user.email ?? user.id;

const projectLabel = (project: AutomationProjectRecord) =>
  project.name?.trim() || project.slug?.trim() || toExternalId(project.id) || "Untitled project";

const marketplaceScopeBasePath = (scope: BackofficeRoutableScopeSelection) =>
  `/backoffice/marketplace/${backofficeRouteScopePath(
    backofficeRouteScopeFromResolvedScope(scope),
  )}`;

export const marketplaceScopeTabPath = (
  scope: BackofficeRoutableScopeSelection,
  tab: MarketplaceTab = "marketplace",
) => `${marketplaceScopeBasePath(scope)}/${tab}`;

const marketplaceScopeSwitchPath = ({
  destinationScope,
  selectedScope,
  pathname,
  search,
}: {
  destinationScope: BackofficeRoutableScopeSelection;
  selectedScope: BackofficeRoutableScopeSelection;
  pathname: string;
  search: string;
}) => {
  const selectedScopeBasePath = marketplaceScopeBasePath(selectedScope);
  const nestedPath = pathname.startsWith(`${selectedScopeBasePath}/`)
    ? pathname.slice(selectedScopeBasePath.length)
    : "/marketplace";

  return `${marketplaceScopeBasePath(destinationScope)}${nestedPath}${search}`;
};

/** Resolves a slug-backed Marketplace route into ID-backed runtime scope identity. */
export function marketplaceRuntimeScopeFromRouteParams(
  params: { scopeKind?: string; scopeId?: string },
  organizations: Organization[],
) {
  const routeScope = requireBackofficeRouteScopeFromParams(params);
  if (routeScope.kind === "system") {
    throw new Response("Not Found", { status: 404 });
  }
  const resolvedScope = resolveBackofficeRouteScope(routeScope, organizations);
  if (!resolvedScope) {
    throw new Response("Not Found", { status: 404 });
  }
  return backofficeRuntimeScopeFromResolvedScope(resolvedScope);
}

export const resolveMarketplaceScopeSelection = ({
  params,
  organizations,
  project,
  user,
}: {
  params: { scopeKind?: string; scopeId?: string };
  organizations: Organization[];
  project: AutomationProjectRecord | null;
  user: BackofficeMeData["user"];
}): BackofficeRoutableScopeSelection => {
  let resolvedScope;
  try {
    const routeScope = requireBackofficeRouteScopeFromParams(params);
    if (routeScope.kind === "system") {
      throw new Response("Not Found", { status: 404 });
    }
    resolvedScope = resolveBackofficeRouteScope(routeScope, organizations);
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    throw new Response("Not Found", { status: 404 });
  }
  if (!resolvedScope) {
    throw new Response("Not Found", { status: 404 });
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

  if (resolvedScope.userId !== user.id) {
    throw new Response("Not Found", { status: 404 });
  }
  return { kind: "user", userId: user.id, label: userName(user) };
};

export const createMarketplaceScopeOptions = ({
  organizations,
  projects,
  user,
  selectedScope,
  currentLocation,
  projectOrgId,
}: {
  organizations: Organization[];
  projects: AutomationProjectRecord[];
  user: BackofficeMeData["user"];
  selectedScope: BackofficeRoutableScopeSelection;
  currentLocation: { pathname: string; search: string };
  projectOrgId: string | null;
}): MarketplaceScopeOption[] => {
  const organizationOptions = organizations.map((organization) => {
    const scope: BackofficeRoutableScopeSelection = {
      kind: "org",
      organization: backofficeOrganizationIdentity(organization),
      label: organization.name ?? organization.id,
    };
    return {
      id: `org:${organization.id}`,
      kind: "org" as const,
      label: scope.label,
      description: "Organization workspace",
      to: marketplaceScopeSwitchPath({
        destinationScope: scope,
        selectedScope,
        ...currentLocation,
      }),
    };
  });

  const projectOrganization = projectOrgId
    ? (organizations.find((organization) => organization.id === projectOrgId) ?? null)
    : null;
  const projectOptions = projectOrganization
    ? projects.flatMap((project) => {
        if (project.archivedAt) {
          return [];
        }
        const projectId = toExternalId(project.id);
        const scope: BackofficeRoutableScopeSelection = {
          kind: "project",
          organization: backofficeOrganizationIdentity(projectOrganization),
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

  const userScope: BackofficeRoutableScopeSelection = {
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
