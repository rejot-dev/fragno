import {
  backofficeScopeIdCodec,
  type BackofficeContextScope,
  BackofficeScopeParseError,
  formatBackofficeScopeRoutePath,
  parseBackofficeScopeRouteParams,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

/** Encodes an ID-backed scope as the `<kind>/<id>` path of Backoffice runtime API routes. */
export function backofficeContextScopeRoutePath(scope: BackofficeContextScope): string {
  return formatBackofficeScopeRoutePath(scope, backofficeScopeIdCodec);
}

export function backofficeContextScopeFromRouteParams({
  scopeKind,
  scopeId,
}: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeContextScope | null {
  if (!scopeKind && !scopeId) {
    return null;
  }
  if (!scopeKind || !scopeId) {
    throw new BackofficeScopeParseError("Route scope requires both kind and id components.");
  }
  return parseBackofficeScopeRouteParams({ scopeKind, scopeId }, backofficeScopeIdCodec);
}

/** Requires route parameters to contain one complete ID-backed runtime scope. */
export function requireBackofficeContextScopeFromRouteParams(params: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeContextScope {
  const scope = backofficeContextScopeFromRouteParams(params);
  if (!scope) {
    throw new BackofficeScopeParseError(
      "A scoped Backoffice runtime route did not provide a scope.",
    );
  }
  return scope;
}
