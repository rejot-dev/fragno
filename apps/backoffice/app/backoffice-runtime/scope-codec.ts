import {
  type BackofficeContextScope,
  backofficeContextScopesEqual,
  type BackofficeRoutableScope,
  BackofficeScopeParseError,
  isBackofficeScopeParseError,
  parseBackofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

const encodeScopeComponent = (value: string) => encodeURIComponent(value);

const invalidScope = (message: string): never => {
  throw new BackofficeScopeParseError(message);
};

const decodeScopeComponent = (value: string, label: string): string => {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) {
      invalidScope(`Missing ${label}.`);
    }
    return decoded;
  } catch (error) {
    if (isBackofficeScopeParseError(error)) {
      throw error;
    }
    return invalidScope(`Invalid ${label} encoding.`);
  }
};

export const backofficeContextScopeRouteId = (scope: BackofficeContextScope) => {
  switch (scope.kind) {
    case "system":
      return "system";
    case "org":
      return encodeScopeComponent(scope.orgId);
    case "project":
      return `${encodeScopeComponent(scope.orgId)}:${encodeScopeComponent(scope.projectId)}`;
    case "user":
      return encodeScopeComponent(scope.userId);
  }

  throw new Error("Unsupported Backoffice context scope kind.");
};

export const backofficeContextScopeRoutePath = (scope: BackofficeContextScope) =>
  `${scope.kind}/${encodeURIComponent(backofficeContextScopeRouteId(scope))}`;

export const backofficeContextScopeFromRouteParams = ({
  scopeKind,
  scopeId,
}: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeContextScope | null => {
  if (!scopeKind && !scopeId) {
    return null;
  }
  if (!scopeKind || !scopeId) {
    return invalidScope("Route scope requires both kind and id components.");
  }

  if (scopeKind === "system") {
    if (scopeId !== "system") {
      return invalidScope("System scope requires the system id.");
    }
    return { kind: "system" };
  }

  if (scopeKind === "org") {
    return { kind: "org", orgId: decodeScopeComponent(scopeId, "org id") };
  }

  if (scopeKind === "project") {
    const parts = scopeId.split(":");
    if (parts.length !== 2) {
      invalidScope("Project scope requires org and project ids.");
    }

    return {
      kind: "project",
      orgId: decodeScopeComponent(parts[0] ?? "", "org id"),
      projectId: decodeScopeComponent(parts[1] ?? "", "project id"),
    };
  }

  if (scopeKind === "user") {
    return { kind: "user", userId: decodeScopeComponent(scopeId, "user id") };
  }

  return invalidScope(`Unknown scope kind '${scopeKind}'.`);
};

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

export const backofficeScopeFromRouteParams = (params: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeRoutableScope | null => {
  const scope = backofficeContextScopeFromRouteParams(params);
  if (scope?.kind === "system") {
    return invalidScope("System scope is not routable here.");
  }
  return scope;
};

export const assertSameBackofficeRoutableScope = (
  existing: BackofficeRoutableScope | null,
  next: BackofficeRoutableScope,
  message = "Already configured for a different scope.",
) => {
  if (existing && !backofficeContextScopesEqual(existing, next)) {
    throw new Error(message);
  }
};

export const backofficeScopeFromSinglePathSegment = (segment: string): BackofficeRoutableScope => {
  const scope = parseBackofficeScopePathSegment(segment);
  if (scope.kind === "system") {
    return invalidScope("System scope is not routable here.");
  }
  return scope;
};
