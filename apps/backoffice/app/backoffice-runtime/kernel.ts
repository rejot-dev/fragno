import { resolveExecutionFilePrincipal, type FilePrincipal } from "@/files/permissions";
import { automationActorsSchema } from "@/fragno/automation/actors";

import type { BackofficeAuthorityResolver } from "./authority-resolver";
import {
  getBackofficeAuthorityRoleGrants,
  resolveBackofficeInternalServiceAuthorityRole,
  resolveBackofficeUserAuthorityRole,
} from "./authority-roles";
import {
  backofficeContextScopesEqual,
  backofficeVerifiedRequestAuthoritySchema,
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
  /** Observe a successfully authorized action, including checks that do not execute through invoke(). */
  observeAuthorization?(action: BackofficeKernelAction): Promise<void>;
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

/**
 * Authorizes sensitive Backoffice actions against trusted execution provenance.
 *
 * Use `invoke()` for actions whose side effect can be expressed as a callback. It keeps
 * authorization, observation, and exactly-once execution in one boundary. Use
 * `assertAuthorized()` only at framework boundaries where successful authorization must allow an
 * external router, middleware chain, or transaction handler to continue the operation.
 *
 * `scoped()` is not an authorization method. It only validates object availability and selects the
 * Durable Object address for an already-established scope.
 */
export class BackofficeKernel {
  readonly #authorityResolver: BackofficeAuthorityResolver;
  readonly #observer: BackofficeKernelObserver;

  constructor(runtime: BackofficeKernelRuntime) {
    this.#authorityResolver = runtime.authorityResolver;
    this.#observer = runtime.kernelObserver;
  }

  /**
   * Checks an action without executing it, selecting authority from the execution context.
   *
   * Verified request authority resolves permissions from the JWT role snapshot without rereading
   * Auth. Executions without token authority resolve current identity state through the configured
   * authority resolver. Prefer `invoke()` when this code owns the sensitive side effect; use this
   * method when successful authorization delegates execution to framework-owned code.
   */
  async assertAuthorized(action: BackofficeKernelAction): Promise<void> {
    await this.#authorizeForExecution(action);
  }

  /**
   * Authorizes and executes a sensitive effect exactly once through the configured observer.
   *
   * This is the preferred kernel API for application-owned effects. The callback is not called when
   * authority resolution fails, permissions are insufficient, or execution provenance is invalid.
   */
  async invoke<T>({
    execution,
    operation,
    resource,
    execute,
  }: BackofficeKernelAction & { execute: () => Promise<T> }): Promise<T> {
    const action = await this.#authorizeForExecution({ execution, operation, resource });
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

  /**
   * Selects the authoritative permission source encoded by the trusted execution boundary.
   * Immediate requests carry a verified JWT snapshot; deferred and internal executions omit that
   * snapshot so role changes, bans, memberships, and service grants resolve from current state.
   */
  async #authorizeForExecution(action: BackofficeKernelAction): Promise<BackofficeKernelAction> {
    return action.execution.userAuthority
      ? await this.#authorizeVerifiedRequest(action)
      : await this.#authorizeCurrentAuthority(action);
  }

  /** Resolves an immediate request exclusively from its verified JWT authority snapshot. */
  async #authorizeVerifiedRequest(action: BackofficeKernelAction): Promise<BackofficeKernelAction> {
    const trustedExecution = this.#parseExecutionContext(action.execution);
    const tokenAuthority = trustedExecution.userAuthority;
    if (!tokenAuthority || tokenAuthority.expiresAtEpochMs <= Date.now()) {
      throw new BackofficeForbiddenError(
        "This request requires unexpired verified access-token authority.",
        "context-access-denied",
      );
    }

    if (trustedExecution.actors.delegation.length > 0) {
      throw new BackofficeForbiddenError(
        "Verified user requests cannot carry delegated authority.",
        "context-access-denied",
      );
    }

    const role = resolveBackofficeUserAuthorityRole(tokenAuthority, trustedExecution.scope);
    const permissions = role ? getBackofficeAuthorityRoleGrants(role) : [];
    if (!permissions.some((grant) => backofficePermissionsEqual(grant, action.operation))) {
      throw new BackofficeForbiddenError(
        "The verified access-token role does not have the required permission.",
        "principal-permission-denied",
      );
    }

    const authorizedAction = {
      execution: trustedExecution,
      operation: action.operation,
      resource: action.resource,
    };
    await this.#observer.observeAuthorization?.(authorizedAction);
    return authorizedAction;
  }

  /** Resolves deferred and internal execution against current authoritative identity state. */
  async #authorizeCurrentAuthority({
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

    const authorizedAction = { execution: trustedExecution, operation, resource };
    await this.#observer.observeAuthorization?.(authorizedAction);
    return authorizedAction;
  }

  #parseExecutionContext(execution: BackofficeExecutionContext): BackofficeExecutionContext {
    const parsedScope = backofficeContextScopeSchema.safeParse(execution.scope);
    const parsedActors = automationActorsSchema.safeParse(execution.actors);
    const parsedUserAuthority = execution.userAuthority
      ? backofficeVerifiedRequestAuthoritySchema.safeParse(execution.userAuthority)
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
    // TODO: This fn needs to go
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

  /**
   * Selects a configured Durable Object binding at the requested scope.
   *
   * This performs structural availability and addressing checks only. The caller must establish
   * authentication and operation authorization before invoking sensitive object methods.
   */
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
