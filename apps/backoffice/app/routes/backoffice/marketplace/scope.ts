import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import {
  backofficeScopeFromRouteParams,
  backofficeContextScopeRoutePath,
} from "@/backoffice-runtime/scope-codec";
import type { AuthMeData } from "@/fragno/auth/auth-client";

import type { AutomationProjectRecord } from "../automations/data";
import { toExternalId } from "../automations/data";

export type MarketplaceTab = "marketplace" | "installed" | "my-listings";

export type MarketplaceUiScope =
  | { kind: "org"; orgId: string; label: string }
  | { kind: "project"; orgId: string; projectId: string; label: string }
  | { kind: "user"; userId: string; label: string };

type Organisation = AuthMeData["organizations"][number]["organization"];

const userName = (user: AuthMeData["user"]) => user.email ?? user.id;

const projectLabel = (project: AutomationProjectRecord) =>
  project.name?.trim() || project.slug?.trim() || toExternalId(project.id) || "Untitled project";

const toMarketplaceTargetScope = (scope: MarketplaceUiScope): BackofficeRoutableScope => {
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

const marketplaceScopeBasePath = (scope: MarketplaceUiScope) =>
  `/backoffice/marketplace/${backofficeContextScopeRoutePath(toMarketplaceTargetScope(scope))}`;

export const marketplaceScopeTabPath = (
  scope: MarketplaceUiScope,
  tab: MarketplaceTab = "marketplace",
) => `${marketplaceScopeBasePath(scope)}/${tab}`;

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
  project,
  user,
}: {
  params: { scopeKind?: string; scopeId?: string };
  organisations: Organisation[];
  project: AutomationProjectRecord | null;
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
    if (
      !organisation ||
      !project ||
      toExternalId(project.id) !== parsed.projectId ||
      project.archivedAt
    ) {
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
