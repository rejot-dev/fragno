import { resolveActorFilePrincipal, type FilePrincipal } from "@/files/permissions";
import {
  automationActorsSchema,
  type AutomationExecutionContext,
} from "@/fragno/automation/actors";

import type { BackofficeAuthorityResolver } from "./authority-resolver";
import {
  backofficeContextScopesEqual,
  type BackofficeContextScope,
  type BackofficeExecutionContext,
} from "./context";
import { backofficeContextScopeSchema } from "./context-schema";
import type { BackofficeObjectBindingName } from "./object-registry";
import { backofficeObjectScopePolicy } from "./object-registry";
import { BACKOFFICE_PERMISSION, type BackofficePermissionRequirement } from "./permissions";
import { backofficeScopeSinglePathSegment } from "./scope-codec";

export type BackofficeKernelAction = {
  execution: AutomationExecutionContext;
  operation: BackofficePermissionRequirement;
  resource?: unknown;
};

export type BackofficeKernelObserver = {
  runAction<T>(action: BackofficeKernelAction, execute: () => Promise<T>): Promise<void>;
};

/** Executes authorized actions without recording or instrumenting them. */
export const noopBackofficeKernelObserver: BackofficeKernelObserver = {
  async runAction<T>(_action: BackofficeKernelAction, execute: () => Promise<T>): Promise<void> {
    await execute();
  },
};

export type BackofficeKernelRuntime = {
  authorityResolver: BackofficeAuthorityResolver;
  kernelObserver: BackofficeKernelObserver;
};

export type BackofficeAuthorizationDenialReason =
  | "authority-unavailable"
  | "principal-permission-denied"
  | "actor-capability-denied"
  | "context-access-denied"
  | "policy-denied";

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
  constructor(
    message = "Forbidden",
    readonly reason: BackofficeAuthorizationDenialReason = "policy-denied",
  ) {
    super(message);
    this.name = "BackofficeForbiddenError";
  }
}

const objectScopeKind = (scope: BackofficeContextScope) =>
  scope.kind === "system" ? "singleton" : scope.kind;

const backofficePermissionsEqual = (
  grant: BackofficePermissionRequirement,
  requirement: BackofficePermissionRequirement,
) => grant.namespace === requirement.namespace && grant.permission === requirement.permission;

export class BackofficeKernel {
  readonly #authorityResolver: BackofficeAuthorityResolver;
  readonly #observer: BackofficeKernelObserver;

  constructor(runtime: BackofficeKernelRuntime) {
    this.#authorityResolver = runtime.authorityResolver;
    this.#observer = runtime.kernelObserver;
  }

  async invoke<T>({
    execution,
    operation,
    resource,
    execute,
  }: BackofficeKernelAction & { execute: () => Promise<T> }): Promise<T> {
    const parsedScope = backofficeContextScopeSchema.safeParse(execution.scope);
    const parsedActors = automationActorsSchema.safeParse(execution.actors);
    if (!parsedScope.success || !parsedActors.success) {
      throw new BackofficeForbiddenError(
        "Automation execution context is invalid.",
        "context-access-denied",
      );
    }

    const trustedExecution: AutomationExecutionContext = {
      scope: parsedScope.data,
      actors: parsedActors.data,
    };

    const authorityResolver = this.#authorityResolver;
    this.#assertAutomationContextAccess(trustedExecution);

    const principal = trustedExecution.actors.principal;
    if (principal) {
      let permissions: readonly BackofficePermissionRequirement[];
      try {
        permissions = await authorityResolver.resolvePrincipalPermissions({
          principal,
          execution: trustedExecution,
        });
      } catch {
        throw new BackofficeForbiddenError(
          "Backoffice authority resolution is unavailable.",
          "authority-unavailable",
        );
      }

      if (!permissions.some((grant) => backofficePermissionsEqual(grant, operation))) {
        throw new BackofficeForbiddenError(
          "The current principal does not have the required permission.",
          "principal-permission-denied",
        );
      }
    } else if (!this.#isTrustedSystemExecution(trustedExecution)) {
      if (!this.#isAllowedBootstrapAction(trustedExecution, operation, resource)) {
        throw new BackofficeForbiddenError(
          "This action requires current principal authority.",
          "principal-permission-denied",
        );
      }
    }

    // TODO: Express this ordered authorization chain without triggering async-await-in-loop.
    for (const actor of trustedExecution.actors.delegation) {
      let grants: readonly BackofficePermissionRequirement[];
      try {
        grants = await authorityResolver.resolveActorCapabilityGrants({
          actor,
          execution: trustedExecution,
        });
      } catch {
        throw new BackofficeForbiddenError(
          "Backoffice authority resolution is unavailable.",
          "authority-unavailable",
        );
      }

      if (!grants.some((grant) => backofficePermissionsEqual(grant, operation))) {
        throw new BackofficeForbiddenError(
          "A delegated actor does not have the required capability grant.",
          "actor-capability-denied",
        );
      }
    }

    const action = { execution: trustedExecution, operation, resource };
    let observerActive = true;
    let observerFailure: { error: unknown } | null = null;
    const observedExecution: { promise: Promise<T> | null } = { promise: null };

    try {
      await this.#observer.runAction(action, async () => {
        if (!observerActive) {
          throw new BackofficeUnavailableError(
            "Backoffice kernel observer attempted to execute an action after observation completed.",
          );
        }
        if (observedExecution.promise) {
          throw new BackofficeUnavailableError(
            "Backoffice kernel observer attempted to execute an action more than once.",
          );
        }

        observedExecution.promise = (async () => await execute())();
        return await observedExecution.promise;
      });
    } catch (error) {
      observerFailure = { error };
    } finally {
      observerActive = false;
    }

    const completedExecution = observedExecution.promise;
    if (!completedExecution) {
      if (observerFailure) {
        throw observerFailure.error;
      }
      throw new BackofficeUnavailableError(
        "Backoffice kernel observer completed without executing the authorized action.",
      );
    }

    const result = await completedExecution;
    if (observerFailure) {
      throw observerFailure.error;
    }
    return result;
  }

  #assertAutomationContextAccess(execution: AutomationExecutionContext) {
    if (execution.scope.kind === "system" && !this.#isTrustedSystemExecution(execution)) {
      throw new BackofficeForbiddenError(
        "System context requires a trusted system initiator.",
        "context-access-denied",
      );
    }

    if (
      execution.scope.kind === "user" &&
      execution.actors.principal &&
      execution.actors.principal.id !== execution.scope.userId
    ) {
      throw new BackofficeForbiddenError("Forbidden", "context-access-denied");
    }
  }

  #isTrustedSystemExecution(execution: AutomationExecutionContext) {
    const { initiator } = execution.actors;
    return initiator.scope === "internal" && initiator.type === "system";
  }

  #isAllowedBootstrapAction(
    execution: AutomationExecutionContext,
    operation: BackofficePermissionRequirement,
    resource: unknown,
  ) {
    const { initiator } = execution.actors;
    if (initiator.scope !== "external") {
      return false;
    }

    if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
      return false;
    }
    const target = resource as Record<string, unknown>;

    if (backofficePermissionsEqual(operation, BACKOFFICE_PERMISSION.otp.create)) {
      return (
        target.kind === "external-identity" &&
        target.source === initiator.source &&
        target.externalType === initiator.type &&
        target.externalId === initiator.id
      );
    }

    return (
      backofficePermissionsEqual(operation, BACKOFFICE_PERMISSION.telegram.send) &&
      initiator.source === "telegram" &&
      initiator.type === "chat" &&
      target.kind === "telegram-chat" &&
      target.chatId === initiator.id
    );
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
