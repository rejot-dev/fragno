import {
  backofficeOrganizationSlugCodec,
  type BackofficePublicScope,
  backofficePublicScopeCodec,
  type BackofficeRoutable,
  type BackofficeScope,
  type BackofficeScopeCodec,
  BackofficeScopeParseError,
  formatBackofficeScopeRoutePath,
  formatBackofficeScopeSegment,
  parseBackofficeScopeRouteParams,
  parseBackofficeScopeSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

type BackofficeRouteScopeNames = {
  organization: { orgSlug: string };
  project: { projectSlug: string };
};

/** Untrusted scope identity read from or written to a Backoffice page URL, named by slugs. */
export type BackofficeRouteScope = BackofficeScope<BackofficeRouteScopeNames>;

export type BackofficeRoutableRouteScope = BackofficeRoutable<BackofficeRouteScope>;

const routeScopeCodec: BackofficeScopeCodec<BackofficeRouteScopeNames> = {
  organization: backofficeOrganizationSlugCodec,
  project: {
    label: "project slug",
    format: (name) => name.projectSlug,
    parse: (projectSlug) => ({ projectSlug }),
  },
};

/** Encodes a Backoffice page URL scope, e.g. `project/org:acme:website`. */
export function backofficeRouteScopePath(scope: BackofficeRouteScope): string {
  return formatBackofficeScopeRoutePath(scope, routeScopeCodec);
}

/** Parses untrusted route parameters without assigning runtime meaning to slugs. */
export function backofficeRouteScopeFromParams(params: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeRouteScope | null {
  const { scopeKind, scopeId } = params;
  if (!scopeKind && !scopeId) {
    return null;
  }
  if (!scopeKind || !scopeId) {
    throw new BackofficeScopeParseError("Route scope requires both kind and id components.");
  }
  return parseBackofficeScopeRouteParams({ scopeKind, scopeId }, routeScopeCodec);
}

/** Requires route parameters to contain one complete Backoffice page scope. */
export function requireBackofficeRouteScopeFromParams(params: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeRouteScope {
  const routeScope = backofficeRouteScopeFromParams(params);
  if (!routeScope) {
    throw new BackofficeScopeParseError("A scoped Backoffice route did not provide a scope.");
  }
  return routeScope;
}

/** Encodes the scope segment of a public fragment URL, e.g. `project:org:acme:<projectId>`. */
export function backofficePublicScopePathSegment(
  scope: BackofficeRoutable<BackofficePublicScope>,
): string {
  return formatBackofficeScopeSegment(scope, backofficePublicScopeCodec);
}

/** Parses the untrusted scope segment of a public fragment URL. */
export function backofficePublicScopeFromPathSegment(
  segment: string,
): BackofficeRoutable<BackofficePublicScope> {
  const scope = parseBackofficeScopeSegment(segment, backofficePublicScopeCodec);
  if (scope.kind === "system") {
    throw new BackofficeScopeParseError("System scope is not routable here.");
  }
  return scope;
}
