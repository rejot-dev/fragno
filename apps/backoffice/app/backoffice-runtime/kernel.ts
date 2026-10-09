import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeAuthorityResolver } from "./authority-resolver";
import { resolveBackofficeInternalServiceAuthorityRole } from "./authority-roles";
import {
  backofficeContextScopesEqual,
  backofficeExecutionContextSchema,
  backofficeScopeContains,
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "./context";
import type { BackofficeObjectBindingName } from "./object-registry";
import {
  backofficeObjectScopePolicy,
  isBackofficeObjectAvailableInContext,
} from "./object-registry";

export type BackofficeKernelAction = {
  execution: BackofficeExecutionContext;
  operation: BackofficePermissionRequirement;
  resource?: unknown;
};

/** One operation that must be authorized as part of an all-of authorization check. */
export type BackofficeKernelAuthorizationRequirement = Omit<BackofficeKernelAction, "execution">;

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

export const BACKOFFICE_AUTHORIZATION_DENIAL_REASONS = [
  "authority-unavailable",
  "principal-permission-denied",
  "actor-capability-denied",
  "context-access-denied",
  "policy-denied",
] as const;

export type BackofficeAuthorizationDenialReason =
  (typeof BACKOFFICE_AUTHORIZATION_DENIAL_REASONS)[number];

const backofficeAuthorizationDenialReasons = new Set<string>(
  BACKOFFICE_AUTHORIZATION_DENIAL_REASONS,
);

export const BACKOFFICE_SCOPE_OPERATIONS = ["automation.forward-event"] as const;

export type BackofficeScopeOperation = (typeof BACKOFFICE_SCOPE_OPERATIONS)[number];

export class BackofficeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackofficeUnavailableError";
  }
}

export type BackofficeUnavailableErrorDetails = Readonly<{
  message: string;
}>;

/** Node entrypoints and object calls can cross bundle or RPC boundaries that do not preserve constructors. */
export function isBackofficeUnavailableError(
  error: unknown,
): error is BackofficeUnavailableErrorDetails {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }
  const candidate = error as Record<string, unknown>;
  return candidate.name === "BackofficeUnavailableError" && typeof candidate.message === "string";
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

export type BackofficeForbiddenErrorDetails = Readonly<{
  message: string;
  reason: BackofficeAuthorizationDenialReason;
}>;

/** Recognizes authorization denials after constructor identity has been lost across a boundary. */
export function isBackofficeForbiddenError(
  error: unknown,
): error is BackofficeForbiddenErrorDetails {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }
  const candidate = error as Record<string, unknown>;
  return (
    candidate.name === "BackofficeForbiddenError" &&
    typeof candidate.message === "string" &&
    typeof candidate.reason === "string" &&
    backofficeAuthorizationDenialReasons.has(candidate.reason)
  );
}

const backofficePermissionsEqual = (
  grant: BackofficePermissionRequirement,
  requirement: BackofficePermissionRequirement,
) => grant.namespace === requirement.namespace && grant.permission === requirement.permission;

/**
 * Authorizes sensitive Backoffice actions against trusted execution provenance.
 *
 * Use `invoke()` for actions whose side effect can be expressed as a callback. It keeps
 * authorization, observation, and exactly-once execution in one boundary. Use
 * `assertAuthorized()` or `assertAuthorizedAll()` only at framework boundaries where successful
 * authorization must allow an external router, middleware chain, or transaction handler to continue.
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
   * Checks every required operation through one authority resolution pass.
   *
   * Principal and delegated actor permissions are resolved once for the complete requirement set.
   * No successful authorization is observed unless every requirement passes.
   */
  async assertAuthorizedAll({
    execution,
    requirements,
  }: {
    execution: BackofficeExecutionContext;
    requirements: readonly BackofficeKernelAuthorizationRequirement[];
  }): Promise<void> {
    await this.#authorizeAllForExecution(execution, requirements);
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
    const [authorizedAction] = await this.#authorizeAllForExecution(action.execution, [
      { operation: action.operation, resource: action.resource },
    ]);
    if (!authorizedAction) {
      throw new BackofficeUnavailableError(
        "Backoffice kernel single-action authorization produced no authorized action.",
      );
    }
    return authorizedAction;
  }

  async #authorizeAllForExecution(
    execution: BackofficeExecutionContext,
    requirements: readonly BackofficeKernelAuthorizationRequirement[],
  ): Promise<readonly BackofficeKernelAction[]> {
    if (requirements.length === 0) {
      return [];
    }

    const authorizedActions = await this.#authorizeRequirements(execution, requirements);
    await Promise.all(
      authorizedActions.map(async (action) => {
        await this.#observer.observeAuthorization?.(action);
      }),
    );
    return authorizedActions;
  }

  /** Both authority sources use the same all-of permission and delegation evaluation. */
  async #authorizeRequirements(
    execution: BackofficeExecutionContext,
    requirements: readonly BackofficeKernelAuthorizationRequirement[],
  ): Promise<readonly BackofficeKernelAction[]> {
    const trustedExecution = this.#parseExecutionContext(execution);
    const principal = trustedExecution.actors.principal;

    const resolvePrincipalAuthority = principal
      ? this.#authorityResolver
          .resolvePrincipalPermissions(
            { principal, execution: trustedExecution },
            requirements.map(({ operation }) => operation),
          )
          .then((permissions) => ({ kind: "principal" as const, permissions }))
      : Promise.resolve({ kind: "principal-free" as const });

    const resolvePrincipalAuthorityResult = resolvePrincipalAuthority.then(
      (value) => ({ status: "fulfilled" as const, value }),
      () => ({ status: "rejected" as const }),
    );
    const resolveDelegatedActorResults = Promise.allSettled(
      trustedExecution.actors.delegation.map((actor) =>
        this.#authorityResolver.resolveActorCapabilityGrants({
          actor,
          execution: trustedExecution,
        }),
      ),
    );
    const [principalAuthorityResult, delegatedActorResults] = await Promise.all([
      resolvePrincipalAuthorityResult,
      resolveDelegatedActorResults,
    ]);

    for (const requirement of requirements) {
      if (principalAuthorityResult.status === "rejected") {
        throw new BackofficeForbiddenError(
          "Backoffice authority resolution is unavailable.",
          "authority-unavailable",
        );
      }

      const resolvedPrincipalAuthority = principalAuthorityResult.value;
      if (resolvedPrincipalAuthority.kind === "principal") {
        if (
          !resolvedPrincipalAuthority.permissions.some((grant) =>
            backofficePermissionsEqual(grant, requirement.operation),
          )
        ) {
          throw new BackofficeForbiddenError(
            "The current principal does not have the required permission.",
            "principal-permission-denied",
          );
        }
      } else if (
        !this.#isTrustedSystemExecution(trustedExecution) &&
        !this.#isAllowedBootstrapAction(
          trustedExecution,
          requirement.operation,
          requirement.resource,
        )
      ) {
        throw new BackofficeForbiddenError(
          "This action requires current principal authority.",
          "principal-permission-denied",
        );
      }

      for (const actorResult of delegatedActorResults) {
        if (actorResult.status === "rejected") {
          throw new BackofficeForbiddenError(
            "Backoffice authority resolution is unavailable.",
            "authority-unavailable",
          );
        }
        if (
          !actorResult.value.some((grant) =>
            backofficePermissionsEqual(grant, requirement.operation),
          )
        ) {
          throw new BackofficeForbiddenError(
            "A delegated actor does not have the required capability grant.",
            "actor-capability-denied",
          );
        }
      }
    }

    return requirements.map((requirement) => ({
      execution: trustedExecution,
      operation: requirement.operation,
      resource: requirement.resource,
    }));
  }

  #parseExecutionContext(execution: BackofficeExecutionContext): BackofficeExecutionContext {
    const parsed = backofficeExecutionContextSchema.safeParse(execution);
    if (!parsed.success) {
      throw new BackofficeForbiddenError(
        "Backoffice execution context is invalid.",
        "context-access-denied",
      );
    }

    const trustedExecution = parsed.data;
    this.#assertExecutionContextAccess(trustedExecution);
    return trustedExecution;
  }

  #assertExecutionContextAccess(execution: BackofficeExecutionContext) {
    const restriction = backofficeExecutionScopeRestriction(execution);
    if (restriction && !backofficeScopeContains(restriction, execution.scope)) {
      throw new BackofficeForbiddenError(
        "Execution scope exceeds its retained scope ceiling.",
        "context-access-denied",
      );
    }
    const principal = execution.actors.principal;
    const hasInternalUserPrincipal = principal?.scope === "internal" && principal.type === "user";

    if (
      execution.kind === "request" &&
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
    const allowed = backofficeObjectScopePolicy[binding];
    if (!isBackofficeObjectAvailableInContext(binding, scope)) {
      throw new BackofficeUnavailableError(
        `${binding} is not available in ${scope.kind} context. Supported scopes: ${allowed.join(", ")}.`,
      );
    }
  }

  assertScopedContextAccess(
    execution: BackofficeExecutionContext,
    targetScope: BackofficeContextScope,
  ) {
    const ownerScope = execution.scope;
    const restriction = backofficeExecutionScopeRestriction(execution);
    if (restriction && !backofficeScopeContains(restriction, targetScope)) {
      throw new BackofficeForbiddenError(
        "Credential scope does not permit the target scope.",
        "context-access-denied",
      );
    }
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
        ownerScope.kind === "system" ? "system" : backofficeScopePathSegment(ownerScope);
      const targetLabel =
        targetScope.kind === "system" ? "system" : backofficeScopePathSegment(targetScope);
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
