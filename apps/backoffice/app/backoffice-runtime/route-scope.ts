import { BackofficeScopeCodecError } from "./scope-codec";

/** Untrusted, slug-backed scope identity read from or written to a public Backoffice route. */
export type BackofficeRouteScope =
  | { kind: "system" }
  | { kind: "org"; orgSlug: string }
  | { kind: "project"; orgSlug: string; projectId: string }
  | { kind: "user"; userId: string };

export type BackofficeRoutableRouteScope = Exclude<BackofficeRouteScope, { kind: "system" }>;

function invalidRouteScope(message: string): never {
  throw new BackofficeScopeCodecError(message);
}

function encodeRouteScopeComponent(value: string): string {
  return encodeURIComponent(value);
}

function decodeRouteScopeComponent(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) {
      invalidRouteScope(`Missing ${label}.`);
    }
    return decoded;
  } catch (error) {
    if (error instanceof BackofficeScopeCodecError) {
      throw error;
    }
    return invalidRouteScope(`Invalid ${label} encoding.`);
  }
}

/** Encodes a public Backoffice route using organization slugs rather than runtime IDs. */
export function backofficeRouteScopePath(scope: BackofficeRouteScope): string {
  switch (scope.kind) {
    case "system":
      return "system/system";
    case "org":
      return `org/${encodeURIComponent(encodeRouteScopeComponent(scope.orgSlug))}`;
    case "project": {
      const routeId = `${encodeRouteScopeComponent(scope.orgSlug)}:${encodeRouteScopeComponent(scope.projectId)}`;
      return `project/${encodeURIComponent(routeId)}`;
    }
    case "user":
      return `user/${encodeURIComponent(encodeRouteScopeComponent(scope.userId))}`;
  }
  throw new Error("Unsupported Backoffice route scope kind.");
}

/** Parses untrusted route parameters without assigning runtime meaning to an organization slug. */
export function backofficeRouteScopeFromParams(params: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeRouteScope | null {
  const { scopeKind, scopeId } = params;
  if (!scopeKind && !scopeId) {
    return null;
  }
  if (!scopeKind || !scopeId) {
    return invalidRouteScope("Route scope requires both kind and id components.");
  }

  if (scopeKind === "system") {
    if (scopeId !== "system") {
      return invalidRouteScope("System scope requires the system id.");
    }
    return { kind: "system" };
  }

  if (scopeKind === "org") {
    return { kind: "org", orgSlug: decodeRouteScopeComponent(scopeId, "organization slug") };
  }

  if (scopeKind === "project") {
    const parts = scopeId.split(":");
    if (parts.length !== 2) {
      return invalidRouteScope("Project scope requires organization and project identifiers.");
    }
    return {
      kind: "project",
      orgSlug: decodeRouteScopeComponent(parts[0] ?? "", "organization slug"),
      projectId: decodeRouteScopeComponent(parts[1] ?? "", "project id"),
    };
  }

  if (scopeKind === "user") {
    return { kind: "user", userId: decodeRouteScopeComponent(scopeId, "user id") };
  }

  return invalidRouteScope(`Unknown scope kind '${scopeKind}'.`);
}

/** Requires route parameters to contain one complete public Backoffice scope. */
export function requireBackofficeRouteScopeFromParams(params: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeRouteScope {
  const routeScope = backofficeRouteScopeFromParams(params);
  if (!routeScope) {
    throw new BackofficeScopeCodecError("A scoped Backoffice route did not provide a scope.");
  }
  return routeScope;
}

/** Encodes decoded route parameters as one slug-backed public API path segment. */
export function backofficeRouteScopeSinglePathSegmentFromParams(params: {
  scopeKind?: string;
  scopeId?: string;
}): string {
  const routeScope = requireBackofficeRouteScopeFromParams(params);
  if (routeScope.kind === "system") {
    throw new BackofficeScopeCodecError("A public fragment route requires a routable scope.");
  }
  return backofficeRouteScopeSinglePathSegment(routeScope);
}

/** Encodes one public API path segment using organization slugs rather than runtime IDs. */
export function backofficeRouteScopeSinglePathSegment(scope: BackofficeRoutableRouteScope): string {
  switch (scope.kind) {
    case "org":
      return `org:${encodeRouteScopeComponent(scope.orgSlug)}`;
    case "project":
      return `project:${encodeRouteScopeComponent(scope.orgSlug)}:${encodeRouteScopeComponent(scope.projectId)}`;
    case "user":
      return `user:${encodeRouteScopeComponent(scope.userId)}`;
  }
  throw new Error("Unsupported Backoffice routable route scope kind.");
}

/** Parses one untrusted public API path segment as slug-backed route identity. */
export function backofficeRouteScopeFromSinglePathSegment(
  segment: string,
): BackofficeRoutableRouteScope {
  const parts = segment.split(":");
  const [scopeKind] = parts;

  if (scopeKind === "org") {
    if (parts.length !== 2) {
      return invalidRouteScope("Organization scope requires exactly one slug component.");
    }
    return {
      kind: "org",
      orgSlug: decodeRouteScopeComponent(parts[1] ?? "", "organization slug"),
    };
  }

  if (scopeKind === "project") {
    if (parts.length !== 3) {
      return invalidRouteScope("Project scope requires organization and project components.");
    }
    return {
      kind: "project",
      orgSlug: decodeRouteScopeComponent(parts[1] ?? "", "organization slug"),
      projectId: decodeRouteScopeComponent(parts[2] ?? "", "project id"),
    };
  }

  if (scopeKind === "user") {
    if (parts.length !== 2) {
      return invalidRouteScope("User scope requires exactly one id component.");
    }
    return { kind: "user", userId: decodeRouteScopeComponent(parts[1] ?? "", "user id") };
  }

  return invalidRouteScope(`Unknown routable scope kind '${scopeKind}'.`);
}
