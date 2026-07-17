import { resolveActorFilePrincipal, type FilePrincipal } from "@/files/permissions";

import {
  backofficeContextScopesEqual,
  type BackofficeContextScope,
  type BackofficeExecutionContext,
  type BackofficePrincipal,
} from "./context";
import type { BackofficeObjectBindingName, BackofficeObjectRegistry } from "./object-registry";
import { backofficeObjectScopePolicy } from "./object-registry";
import { backofficeScopeSinglePathSegment } from "./scope-codec";

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

export const BACKOFFICE_SCOPE_OPERATIONS = [
  "automation.forward-event",
  "billing.record-event",
  "billing.read-trackers",
] as const;

export type BackofficeScopeOperation = (typeof BACKOFFICE_SCOPE_OPERATIONS)[number];

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
      if (actor.type === "user" && actor.role === "admin") {
        return;
      }
      throw new BackofficeForbiddenError("System context requires an admin or system actor.");
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

  async assertScopeAllowedByOwner({
    ownerScope,
    targetScope,
    operation,
  }: {
    ownerScope: BackofficeContextScope;
    targetScope: BackofficeContextScope;
    operation: BackofficeScopeOperation;
  }) {
    const deny = () => {
      const ownerLabel =
        ownerScope.kind === "system" ? "system" : backofficeScopeSinglePathSegment(ownerScope);
      const targetLabel =
        targetScope.kind === "system" ? "system" : backofficeScopeSinglePathSegment(targetScope);
      throw new BackofficeForbiddenError(
        `${operation} cannot use ${targetLabel} within ${ownerLabel}.`,
      );
    };

    switch (ownerScope.kind) {
      case "system":
        return;
      case "org":
        if (
          (targetScope.kind === "org" || targetScope.kind === "project") &&
          targetScope.orgId === ownerScope.orgId
        ) {
          return;
        }
        // TODO: Check the Auth membership table before allowing an org-owned object to use a
        // user scope. Keeping this decision in the kernel means Billing does not need to own
        // membership rules when that lookup becomes available.
        if (targetScope.kind === "user") {
          return;
        }
        deny();
        return;
      case "project":
      case "user":
        if (backofficeContextScopesEqual(ownerScope, targetScope)) {
          return;
        }
        deny();
        return;
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

    throw new Error("Unsupported Backoffice context scope kind.");
  }
}
