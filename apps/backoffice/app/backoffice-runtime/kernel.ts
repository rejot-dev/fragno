import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
  BackofficePrincipal,
} from "./context";
import type { BackofficeObjectBindingName, BackofficeObjectRegistry } from "./object-registry";
import { backofficeObjectScopePolicy } from "./object-scope-policy";

export type BackofficePermissionRequirement = {
  namespace: string;
  permission: string;
};

export type BackofficeAuthorizationRequest = {
  actor: BackofficePrincipal;
  scope: BackofficeContextScope;
  requiredPermissions: readonly BackofficePermissionRequirement[];
  resource?: unknown;
};

export class BackofficeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackofficeUnavailableError";
  }
}

export class BackofficeForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "BackofficeForbiddenError";
  }
}

const objectScopeKind = (scope: BackofficeContextScope) =>
  scope.kind === "system" ? "singleton" : scope.kind;

export class BackofficeKernel {
  readonly objects: BackofficeObjectRegistry;

  constructor({ objects }: { objects: BackofficeObjectRegistry }) {
    this.objects = objects;
  }

  assertContextAccess({ actor, scope }: BackofficeExecutionContext) {
    if (actor.type === "system") {
      return;
    }
    if (scope.kind === "system") {
      throw new BackofficeForbiddenError("System context requires system actor.");
    }
    if (scope.kind === "project") {
      throw new BackofficeUnavailableError("Project context is not available.");
    }
    if (scope.kind === "org" && !actor.organizationIds?.includes(scope.orgId)) {
      throw new BackofficeForbiddenError("Forbidden");
    }
    if (scope.kind === "user" && actor.type === "user" && actor.userId !== scope.userId) {
      throw new BackofficeForbiddenError("Forbidden");
    }
  }

  assertObjectAvailable(binding: BackofficeObjectBindingName, scope: BackofficeContextScope) {
    if (scope.kind === "project") {
      throw new BackofficeUnavailableError("Project context is not available.");
    }
    const physicalScope = objectScopeKind(scope);
    const allowed = backofficeObjectScopePolicy[binding];
    if (!allowed.includes(physicalScope as never)) {
      throw new BackofficeUnavailableError(
        `${binding} is not available in ${scope.kind} context. Supported scopes: ${allowed.join(", ")}.`,
      );
    }
  }

  assertAllowed(request: BackofficeAuthorizationRequest) {
    this.assertContextAccess({ actor: request.actor, scope: request.scope });
  }

  scoped<T>(
    binding: BackofficeObjectBindingName,
    scope: BackofficeContextScope,
    family: {
      singleton(): T;
      forOrg(id: string): T;
      forUser(input: { userId: string }): T;
      forProject(input: { projectId: string }): T;
    },
  ): T {
    this.assertObjectAvailable(binding, scope);
    switch (scope.kind) {
      case "system":
        return family.singleton();
      case "org":
        return family.forOrg(scope.orgId);
      case "user":
        return family.forUser({ userId: scope.userId });
      case "project":
        return family.forProject({ projectId: scope.projectId });
    }
  }
}

export const createBackofficeKernel = (input: { objects: BackofficeObjectRegistry }) =>
  new BackofficeKernel(input);
