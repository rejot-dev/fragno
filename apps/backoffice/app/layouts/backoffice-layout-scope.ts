import { isBackofficeScopeParseError } from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  type BackofficeOrganizationIdentity,
  type BackofficeProjectIdentity,
  type BackofficeRouteScopeResolution,
  resolveBackofficeRouteScope,
  type BackofficeResolvedProjectOwner,
} from "@/backoffice-runtime/resolved-scope";
import {
  backofficeRouteScopeFromParams,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";

type BackofficeRouteScopeParams = {
  scopeKind?: string;
  scopeId?: string;
  orgSlug?: string;
};

/** What a page URL says about its scope: nothing, something unreadable, or a resolution. */
export type BackofficePageScope<
  TOrganization extends BackofficeOrganizationIdentity,
  TProject extends BackofficeProjectIdentity,
> =
  | { status: "absent" }
  | { status: "invalid" }
  | BackofficeRouteScopeResolution<TOrganization, TProject>;

/** Resolves URL identity against the organizations established by authentication. */
export async function resolveBackofficePageScope<
  TOrganization extends BackofficeOrganizationIdentity,
  TProject extends BackofficeProjectIdentity,
>({
  params,
  ...lookups
}: {
  params: BackofficeRouteScopeParams;
  organizations: readonly TOrganization[];
  findProject(
    owner: BackofficeResolvedProjectOwner<TOrganization, TProject>,
    projectSlug: string,
  ): Promise<TProject | null>;
}): Promise<BackofficePageScope<TOrganization, TProject>> {
  let routeScope: BackofficeRouteScope | null;
  try {
    routeScope = backofficeRouteScopeFromParams(params);
    // Organization pages name their organization outside the scoped route parameters.
    if (!routeScope && params.orgSlug) {
      routeScope = { kind: "org", orgSlug: params.orgSlug };
    }
  } catch (error) {
    if (isBackofficeScopeParseError(error)) {
      return { status: "invalid" };
    }
    throw error;
  }
  if (!routeScope) {
    return { status: "absent" };
  }
  return await resolveBackofficeRouteScope(routeScope, lookups);
}
