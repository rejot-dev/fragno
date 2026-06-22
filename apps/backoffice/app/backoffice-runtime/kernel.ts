import { resolveActorFilePrincipal, type FilePrincipal } from "@/files/permissions";

import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
  BackofficePrincipal,
} from "./context";
import type { BackofficeObjectBindingName, BackofficeObjectRegistry } from "./object-registry";
import { backofficeObjectScopePolicy } from "./object-registry";

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

export type BackofficeAuthorizationDecision =
  | { allowed: true }
  | { allowed: false; message?: string };

export type BackofficeAuthorizationPolicy = (
  request: BackofficeAuthorizationRequest,
) => BackofficeAuthorizationDecision;

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
  readonly objects?: BackofficeObjectRegistry;
  readonly #authorizationPolicy?: BackofficeAuthorizationPolicy;

  constructor({
    objects,
    authorizationPolicy,
  }: {
    objects?: BackofficeObjectRegistry;
    authorizationPolicy?: BackofficeAuthorizationPolicy;
  }) {
    this.objects = objects;
    this.#authorizationPolicy = authorizationPolicy;
  }

  assertContextAccess({ actor, scope }: BackofficeExecutionContext) {
    if (actor.type === "system") {
      return;
    }
    if (scope.kind === "system") {
      throw new BackofficeForbiddenError("System context requires system actor.");
    }
    if (
      (scope.kind === "org" || scope.kind === "project") &&
      !actor.organizationIds?.includes(scope.orgId)
    ) {
      throw new BackofficeForbiddenError("Forbidden");
    }
    if (scope.kind === "user" && actor.type === "user" && actor.userId !== scope.userId) {
      throw new BackofficeForbiddenError("Forbidden");
    }
  }

  assertObjectAvailable(binding: BackofficeObjectBindingName, scope: BackofficeContextScope) {
    const physicalScope = objectScopeKind(scope);
    const allowed = backofficeObjectScopePolicy[binding];
    if (!allowed.includes(physicalScope as never)) {
      throw new BackofficeUnavailableError(
        `${binding} is not available in ${scope.kind} context. Supported scopes: ${allowed.join(", ")}.`,
      );
    }
  }

  resolveFilePrincipal(context: BackofficeExecutionContext): FilePrincipal {
    this.assertContextAccess(context);
    return resolveActorFilePrincipal(context);
  }

  assertAllowed(request: BackofficeAuthorizationRequest) {
    this.assertContextAccess({ actor: request.actor, scope: request.scope });

    if (request.requiredPermissions.length === 0) {
      return;
    }

    const decision = this.#authorizationPolicy?.(request) ?? { allowed: true };
    if (!decision.allowed) {
      throw new BackofficeForbiddenError(decision.message ?? "Forbidden");
    }
  }

  scoped<T>(
    binding: BackofficeObjectBindingName,
    scope: BackofficeContextScope,
    family: {
      singleton(): T;
      forOrg(id: string): T;
      forUser(input: { userId: string }): T;
      forProject(input: { orgId: string; projectId: string }): T;
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
        return family.forProject({ orgId: scope.orgId, projectId: scope.projectId });
    }
  }
}
