import { backofficeContextScopesEqual, type BackofficeContextScope } from "./context";

export type BackofficeRoutableScope = Extract<
  BackofficeContextScope,
  { kind: "org" | "project" | "user" }
>;

export const isBackofficeRoutableScope = (
  scope: BackofficeContextScope,
): scope is BackofficeRoutableScope =>
  scope.kind === "org" || scope.kind === "project" || scope.kind === "user";

const encodeScopeComponent = (value: string) => encodeURIComponent(value);

export class BackofficeScopeCodecError extends Error {
  readonly code = "INVALID_BACKOFFICE_SCOPE";

  constructor(message: string) {
    super(message);
    this.name = "BackofficeScopeCodecError";
  }
}

const invalidScope = (message: string): never => {
  throw new BackofficeScopeCodecError(message);
};

const decodeScopeComponent = (value: string, label: string): string => {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) {
      invalidScope(`Missing ${label}.`);
    }
    return decoded;
  } catch (error) {
    if (error instanceof BackofficeScopeCodecError) {
      throw error;
    }
    return invalidScope(`Invalid ${label} encoding.`);
  }
};

export const backofficeScopeRouteId = (scope: BackofficeRoutableScope) => {
  switch (scope.kind) {
    case "org":
      return encodeScopeComponent(scope.orgId);
    case "project":
      return `${encodeScopeComponent(scope.orgId)}:${encodeScopeComponent(scope.projectId)}`;
    case "user":
      return encodeScopeComponent(scope.userId);
  }
};

export const backofficeScopeFromRouteParams = ({
  scopeKind,
  scopeId,
}: {
  scopeKind?: string;
  scopeId?: string;
}): BackofficeRoutableScope | null => {
  if (!scopeKind || !scopeId) {
    return null;
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

export const backofficeScopeSinglePathSegment = (scope: BackofficeRoutableScope) => {
  switch (scope.kind) {
    case "org":
      return `org:${encodeScopeComponent(scope.orgId)}`;
    case "project":
      return `project:${encodeScopeComponent(scope.orgId)}:${encodeScopeComponent(scope.projectId)}`;
    case "user":
      return `user:${encodeScopeComponent(scope.userId)}`;
  }
};

export const backofficeRoutableScopesEqual = (
  left: BackofficeRoutableScope,
  right: BackofficeRoutableScope,
) => backofficeContextScopesEqual(left, right);

export const assertSameBackofficeRoutableScope = (
  existing: BackofficeRoutableScope | null,
  next: BackofficeRoutableScope,
  message = "Already configured for a different scope.",
) => {
  if (existing && !backofficeRoutableScopesEqual(existing, next)) {
    throw new Error(message);
  }
};

export const backofficeScopeFromSinglePathSegment = (segment: string): BackofficeRoutableScope => {
  const parts = segment.split(":");
  const [scopeKind] = parts;

  if (scopeKind === "org") {
    if (parts.length !== 2) {
      invalidScope("Org scope requires exactly one id component.");
    }
    return { kind: "org", orgId: decodeScopeComponent(parts[1] ?? "", "org id") };
  }

  if (scopeKind === "project") {
    if (parts.length !== 3) {
      invalidScope("Project scope requires org and project id components.");
    }
    return {
      kind: "project",
      orgId: decodeScopeComponent(parts[1] ?? "", "org id"),
      projectId: decodeScopeComponent(parts[2] ?? "", "project id"),
    };
  }

  if (scopeKind === "user") {
    if (parts.length !== 2) {
      invalidScope("User scope requires exactly one id component.");
    }
    return { kind: "user", userId: decodeScopeComponent(parts[1] ?? "", "user id") };
  }

  return invalidScope(`Unknown scope kind '${scopeKind}'.`);
};
