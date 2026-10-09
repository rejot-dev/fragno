import { BackofficeScopeParseError } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { resolveBackofficeRouteScope } from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeRouteScopeFromParams } from "@/backoffice-runtime/route-scope";

type BackofficeRouteScopeParams = {
  scopeKind?: string;
  scopeId?: string;
  orgSlug?: string;
};

/** Resolves URL identity against the organizations established by authentication. */
export function resolveCurrentBackofficeScope<TOrganization extends { id: string; slug: string }>({
  params,
  defaultScope,
  organizations,
}: {
  params: BackofficeRouteScopeParams;
  defaultScope: BackofficeResolvedScope<TOrganization>;
  organizations: TOrganization[];
}): BackofficeResolvedScope<TOrganization> {
  if (params.scopeKind !== undefined || params.scopeId !== undefined) {
    const routeScope = requireBackofficeRouteScopeFromParams(params);
    const resolvedScope = resolveBackofficeRouteScope(routeScope, organizations);
    if (!resolvedScope) {
      const organizationSlug =
        routeScope.kind === "org" || routeScope.kind === "project" ? routeScope.orgSlug : null;
      throw new BackofficeScopeParseError(
        organizationSlug
          ? `Backoffice route organization slug '${organizationSlug}' was not found.`
          : "Backoffice route scope could not be resolved.",
      );
    }
    return resolvedScope;
  }

  if (params.orgSlug) {
    const resolvedScope = resolveBackofficeRouteScope(
      { kind: "org", orgSlug: params.orgSlug },
      organizations,
    );
    if (!resolvedScope) {
      throw new BackofficeScopeParseError(
        `Backoffice route organization slug '${params.orgSlug}' was not found.`,
      );
    }
    return resolvedScope;
  }

  return defaultScope;
}
