import { resolveExecutionFilePrincipal, type FilePrincipal } from "@/files/permissions";
import { automationActorsSchema } from "@/fragno/automation/actors";

import type { BackofficeAuthorityResolver } from "./authority-resolver";
import { resolveBackofficeInternalServiceAuthorityRole } from "./authority-roles";
import {
  backofficeContextScopesEqual,
  backofficeVerifiedAccessTokenAuthoritySchema,
  type BackofficeContextScope,
  type BackofficeExecutionContext,
} from "./context";
import { backofficeContextScopeSchema } from "./context-schema";
import type { BackofficeObjectBindingName } from "./object-registry";
import { backofficeObjectScopePolicy } from "./object-registry";
import { BACKOFFICE_PERMISSION, type BackofficePermissionRequirement } from "./permissions";
import { backofficeScopeSinglePathSegment } from "./scope-codec";

export type BackofficeKernelAction = {
  execution: BackofficeExecutionContext;
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

type BackofficeKernelRuntime = {
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

  async assertAuthorized(action: BackofficeKernelAction): Promise<void> {
    await this.#authorize(action);
  }

  async invoke<T>({
    execution,
    operation,
    resource,
    execute,
  }: BackofficeKernelAction & { execute: () => Promise<T> }): Promise<T> {
    const action = await this.#authorize({ execution, operation, resource });
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

  async #authorize({
    execution,
    operation,
    resource,
  }: BackofficeKernelAction): Promise<BackofficeKernelAction> {
    const trustedExecution = this.#parseExecutionContext(execution);
    const principal = trustedExecution.actors.principal;

    if (principal) {
      let permissions: readonly BackofficePermissionRequirement[];
      try {
        permissions = await this.#authorityResolver.resolvePrincipalPermissions({
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
    } else if (
      !this.#isTrustedSystemExecution(trustedExecution) &&
      !this.#isAllowedBootstrapAction(trustedExecution, operation, resource)
    ) {
      throw new BackofficeForbiddenError(
        "This action requires current principal authority.",
        "principal-permission-denied",
      );
    }

    // TODO: Express this ordered authorization chain without triggering async-await-in-loop.
    for (const actor of trustedExecution.actors.delegation) {
      let grants: readonly BackofficePermissionRequirement[];
      try {
        grants = await this.#authorityResolver.resolveActorCapabilityGrants({
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

    return { execution: trustedExecution, operation, resource };
  }

  #parseExecutionContext(execution: BackofficeExecutionContext): BackofficeExecutionContext {
    const parsedScope = backofficeContextScopeSchema.safeParse(execution.scope);
    const parsedActors = automationActorsSchema.safeParse(execution.actors);
    const parsedUserAuthority = execution.userAuthority
      ? backofficeVerifiedAccessTokenAuthoritySchema.safeParse(execution.userAuthority)
      : { success: true as const, data: undefined };
    if (!parsedScope.success || !parsedActors.success || !parsedUserAuthority.success) {
      throw new BackofficeForbiddenError(
        "Backoffice execution context is invalid.",
        "context-access-denied",
      );
    }

    const trustedExecution = {
      scope: parsedScope.data,
      actors: parsedActors.data,
      ...(parsedUserAuthority.data ? { userAuthority: parsedUserAuthority.data } : {}),
    } satisfies BackofficeExecutionContext;
    this.#assertExecutionContextAccess(trustedExecution);
    return trustedExecution;
  }

  #assertExecutionContextAccess(execution: BackofficeExecutionContext) {
    const principal = execution.actors.principal;
    const hasInternalUserPrincipal = principal?.scope === "internal" && principal.type === "user";

    if (
      execution.userAuthority &&
      (!hasInternalUserPrincipal || execution.userAuthority.userId !== principal.id)
    ) {
      throw new BackofficeForbiddenError(
        "Verified user authority does not match the execution principal.",
        "context-access-denied",
      );
    }

    if (
      execution.scope.kind === "system" &&
      !this.#isTrustedSystemExecution(execution) &&
      !hasInternalUserPrincipal
    ) {
      throw new BackofficeForbiddenError(
        "System context requires trusted system execution or an internal user principal.",
        "context-access-denied",
      );
    }

    if (
      execution.scope.kind === "user" &&
      execution.actors.principal?.scope === "internal" &&
      execution.actors.principal.type === "user" &&
      execution.actors.principal.id !== execution.scope.userId
    ) {
      throw new BackofficeForbiddenError("Forbidden", "context-access-denied");
    }
  }

  #isTrustedSystemExecution(execution: BackofficeExecutionContext) {
    const { initiator, principal, delegation } = execution.actors;
    return (
      initiator.scope === "internal" &&
      initiator.type === "system" &&
      principal === null &&
      delegation.every((actor) => resolveBackofficeInternalServiceAuthorityRole(actor) !== null)
    );
  }

  #isAllowedBootstrapAction(
    execution: BackofficeExecutionContext,
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

  assertObjectAvailable(binding: BackofficeObjectBindingName, scope: BackofficeContextScope) {
    const physicalScope = objectScopeKind(scope);
    const allowed = backofficeObjectScopePolicy[binding];
    if (!allowed.includes(physicalScope as never)) {
      throw new BackofficeUnavailableError(
        `${binding} is not available in ${scope.kind} context. Supported scopes: ${allowed.join(", ")}.`,
      );
    }
  }

  resolveFilePrincipal(execution: BackofficeExecutionContext): FilePrincipal {
    const trustedExecution = this.#parseExecutionContext(execution);
    if (!trustedExecution.actors.principal && !this.#isTrustedSystemExecution(trustedExecution)) {
      throw new BackofficeForbiddenError(
        "Filesystem access requires an internal principal or trusted system execution.",
        "context-access-denied",
      );
    }

    const filePrincipal = resolveExecutionFilePrincipal(trustedExecution);
    if (!filePrincipal) {
      throw new BackofficeForbiddenError(
        "Filesystem access requires an internal principal or trusted system execution.",
        "context-access-denied",
      );
    }
    return filePrincipal;
  }

  assertScopedContextAccess(
    execution: BackofficeExecutionContext,
    targetScope: BackofficeContextScope,
  ) {
    const ownerScope = execution.scope;
    if (
      backofficeContextScopesEqual(ownerScope, targetScope) ||
      this.#isTrustedSystemExecution(execution)
    ) {
      return;
    }

    const principal = execution.actors.principal;
    if (
      ownerScope.kind === "system" &&
      principal !== null &&
      resolveBackofficeInternalServiceAuthorityRole(principal) !== null
    ) {
      return;
    }

    if (ownerScope.kind === "org") {
      const targetsOwnerOrganization =
        targetScope.kind === "org" && targetScope.orgId === ownerScope.orgId;
      const targetsProjectInOwnerOrganization =
        targetScope.kind === "project" && targetScope.orgId === ownerScope.orgId;

      if (targetsOwnerOrganization || targetsProjectInOwnerOrganization) {
        return;
      }

      if (targetScope.kind === "user" && principal !== null) {
        const targetsAuthenticatedUser =
          principal.scope === "internal" &&
          principal.type === "user" &&
          principal.id === targetScope.userId;
        const internalServiceCanEnterUserScope =
          resolveBackofficeInternalServiceAuthorityRole(principal) !== null;

        if (targetsAuthenticatedUser || internalServiceCanEnterUserScope) {
          return;
        }
      }
    }

    throw new BackofficeForbiddenError(
      "The execution cannot access the requested Backoffice context.",
      "context-access-denied",
    );
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
