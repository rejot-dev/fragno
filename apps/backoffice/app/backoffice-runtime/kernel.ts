import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  backofficeContextScopesEqual,
  backofficeScopeContains,
  backofficeScopePathSegment,
  backofficeScopeReferenceCodec,
  backofficeScopeRootOwner,
  formatBackofficeScopeSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import { piAgentActorName } from "@/fragno/pi/agent/pi-agent-actor";

import type {
  BackofficeAuthorityResolver,
  BackofficeGrant,
  BackofficeGrantedConnection,
} from "./authority-resolver";
import { resolveBackofficeInternalServiceAuthorityRole } from "./authority-roles";
import {
  backofficeExecutionContextSchema,
  backofficeExecutionScopeRestriction,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "./context";
import type { BackofficeObjectBindingName } from "./object-registry";
import {
  backofficeObjectScopePolicy,
  isBackofficeObjectAvailableInContext,
} from "./object-registry";
import { BackofficeOperationError } from "./operation-error";

const AUTHORITY_ATTEMPTS = 2;
const AUTHORITY_RETRY_DELAY_MS = 200;

/**
 * Deferred work resolves its authority from the Auth object over RPC, which fails now and then for
 * a moment, as when the object restarts. Nothing has run yet, so a failure Cloudflare marks
 * retryable is tried again. An overloaded Auth is not asked again, and any other failure is denied
 * at once. Each failure is logged, because the denial says only that authority was unavailable.
 */
async function resolveAuthority<T>(resolve: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await resolve();
    } catch (error) {
      const fields = authorityErrorFields(error);
      const retrying = attempt < AUTHORITY_ATTEMPTS && fields.retryable && !fields.overloaded;
      (retrying ? console.warn : console.error)("backoffice.authority.resolution.failed", {
        attempt,
        retrying,
        ...fields,
      });
      if (!retrying) {
        throw error;
      }
      await new Promise<void>((resume) => {
        setTimeout(resume, AUTHORITY_RETRY_DELAY_MS);
      });
    }
  }
}

/** Cloudflare marks RPC errors `retryable` when trying again is safe, and `overloaded`. */
function authorityErrorFields(error: unknown) {
  const { retryable, overloaded } =
    error !== null && typeof error === "object"
      ? (error as { retryable?: unknown; overloaded?: unknown })
      : {};
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: error instanceof Error ? error.message : String(error),
    retryable: retryable === true,
    overloaded: overloaded === true,
  };
}

export type BackofficeKernelAction = {
  execution: BackofficeExecutionContext;
  operation: BackofficePermissionRequirement;
  resource?: unknown;
};

/** The resource of a call that executes an action on one connection, in the scope it is in. */
export type BackofficeConnectionResource = BackofficeGrantedConnection & {
  kind: "integration-connection";
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

/** A required object or binding is not configured here, so the operation cannot run. */
export class BackofficeUnavailableError extends BackofficeOperationError {
  constructor(message: string) {
    super("not_found", message);
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
  grant: BackofficePermissionRequirement | BackofficeGrant,
  requirement: BackofficePermissionRequirement,
) => grant.namespace === requirement.namespace && grant.permission === requirement.permission;

// Resources are built by trusted host code, so their kind names their shape.
export function isBackofficeConnectionResource(
  resource: unknown,
): resource is BackofficeConnectionResource {
  return (
    typeof resource === "object" &&
    (resource as { kind?: unknown })?.kind === "integration-connection"
  );
}

/** A connection by its scope's IDs and its address; where the scope is kept does not change it. */
function connectionKey({ scope, connectionId }: BackofficeGrantedConnection): string {
  return `${formatBackofficeScopeSegment(scope, backofficeScopeReferenceCodec)} ${connectionId}`;
}

/**
 * Resources whose check approves a permission for something else to hold: installing a package
 * approves its permissions for its routes and install workflow. They hold the permission whole.
 */
function approvesPermission(resource: unknown): boolean {
  return (
    typeof resource === "object" &&
    (resource as { kind?: unknown })?.kind === "package-installation"
  );
}

/**
 * Whether a grant covers a requirement. Execute on named connections covers a call naming one of
 * them, but never approving execute for something else, which would hold it on every connection.
 * Any other requirement naming no connection is a source's own check of a call that named its
 * connection where it entered: runtime tools that require `integrations.execute` name one.
 */
function grantCovers(
  grant: BackofficeGrant,
  requirement: BackofficeKernelAuthorizationRequirement,
): boolean {
  if (!backofficePermissionsEqual(grant, requirement.operation)) {
    return false;
  }
  const resource = requirement.resource;
  if (!("connections" in grant)) {
    return true;
  }
  if (!isBackofficeConnectionResource(resource)) {
    return !approvesPermission(resource);
  }
  const key = connectionKey(resource);
  return grant.connections.some((connection) => connectionKey(connection) === key);
}

function describeGrant(grant: BackofficeGrant): string {
  const permission = `${grant.namespace}.${grant.permission}`;
  return "connections" in grant
    ? `${permission} on ${grant.connections.map(connectionKey).join(", ")}`
    : permission;
}

/**
 * Why grants that execute on named connections deny a call to another one, or approving execute,
 * naming the connections they do cover; null when the grants do not execute on named connections.
 */
function connectionDenialReason(
  grants: readonly BackofficeGrant[],
  requirement: BackofficeKernelAuthorizationRequirement,
): string | null {
  const grant = grants.find((candidate) =>
    backofficePermissionsEqual(candidate, requirement.operation),
  );
  if (!grant || !("connections" in grant)) {
    return null;
  }
  const covered = grant.connections.map(connectionKey).join(", ");
  if (isBackofficeConnectionResource(requirement.resource)) {
    return `it may execute on ${covered}, not on ${connectionKey(requirement.resource)}`;
  }
  return approvesPermission(requirement.resource)
    ? `it may execute only on ${covered}, so it cannot approve execute on every connection`
    : null;
}

const DENIAL_LISTED_GRANTS = 8;

/** Names the delegate and what it holds, so a denial points at the grant to change. */
function delegatedActorDenialMessage(
  actor: BackofficeExecutionContext["actors"]["delegation"][number],
  requirement: BackofficeKernelAuthorizationRequirement,
  grants: readonly BackofficeGrant[],
): string {
  const actorLabel =
    actor.type === "pi-agent"
      ? `Agent '${piAgentActorName(actor)}'`
      : `Delegated ${actor.type} '${actor.id}'`;
  const connectionReason = connectionDenialReason(grants, requirement);
  if (connectionReason) {
    return `${actorLabel} is not granted this connection: ${connectionReason}.`;
  }
  const listed = grants.slice(0, DENIAL_LISTED_GRANTS).map(describeGrant);
  const held =
    grants.length === 0
      ? "(none)"
      : grants.length > DENIAL_LISTED_GRANTS
        ? `${listed.join(", ")}, and ${grants.length - DENIAL_LISTED_GRANTS} more`
        : listed.join(", ");
  const required = `${requirement.operation.namespace}.${requirement.operation.permission}`;
  // A Pi agent's grants are its definition's permissions, which is where they are changed.
  return actor.type === "pi-agent"
    ? `${actorLabel} is not granted ${required}; its definition grants: ${held}.`
    : `${actorLabel} is not granted ${required}; it is granted: ${held}.`;
}

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
      ? resolveAuthority(() =>
          this.#authorityResolver.resolvePrincipalPermissions(
            { principal, execution: trustedExecution },
            requirements.map(({ operation }) => operation),
          ),
        ).then((permissions) => ({ kind: "principal" as const, permissions }))
      : Promise.resolve({ kind: "principal-free" as const });

    const resolvePrincipalAuthorityResult = resolvePrincipalAuthority.then(
      (value) => ({ status: "fulfilled" as const, value }),
      () => ({ status: "rejected" as const }),
    );
    const resolveDelegatedActorResults = Promise.allSettled(
      trustedExecution.actors.delegation.map((actor) =>
        resolveAuthority(() =>
          this.#authorityResolver.resolveActorCapabilityGrants({
            actor,
            execution: trustedExecution,
          }),
        ),
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
        const grants = resolvedPrincipalAuthority.permissions;
        if (!grants.some((grant) => grantCovers(grant, requirement))) {
          const connectionReason = connectionDenialReason(grants, requirement);
          throw new BackofficeForbiddenError(
            connectionReason
              ? `The current principal '${principal?.id}' is not granted this connection: ${connectionReason}.`
              : "The current principal does not have the required permission.",
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

      for (const [index, actorResult] of delegatedActorResults.entries()) {
        if (actorResult.status === "rejected") {
          throw new BackofficeForbiddenError(
            "Backoffice authority resolution is unavailable.",
            "authority-unavailable",
          );
        }
        if (!actorResult.value.some((grant) => grantCovers(grant, requirement))) {
          throw new BackofficeForbiddenError(
            delegatedActorDenialMessage(
              trustedExecution.actors.delegation[index],
              requirement,
              actorResult.value,
            ),
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
  }

  /** Resolves the user's current permissions in the scope, as deferred work does. */
  async #userMayEmitEvents(userId: string, scope: BackofficeContextScope): Promise<boolean> {
    try {
      await this.assertAuthorized({
        execution: createBackofficeUserExecution({ scope, userId }),
        operation: BACKOFFICE_PERMISSION.events.emit,
      });
      return true;
    } catch (error) {
      if (
        error instanceof BackofficeForbiddenError &&
        error.reason === "principal-permission-denied"
      ) {
        return false;
      }
      throw error;
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

    return (
      backofficePermissionsEqual(operation, BACKOFFICE_PERMISSION.otp.create) &&
      target.kind === "external-identity" &&
      target.source === initiator.source &&
      target.externalType === initiator.type &&
      target.externalId === initiator.id
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

    // A user may reach every scope they can access. Membership is not checked here: every action
    // in the target scope resolves the user's permissions there, which denies foreign organizations.
    // Some writes, like forwarded events, resolve no permissions in their target, so a user reaches
    // only their own personal scopes and, as an administrator, those of the member they work for.
    if (principal?.scope === "internal" && principal.type === "user") {
      const targetOwner = backofficeScopeRootOwner(targetScope);
      const executionOwner = backofficeScopeRootOwner(ownerScope);
      if (
        targetOwner !== null &&
        (targetOwner.kind === "org" ||
          targetOwner.userId === principal.id ||
          (executionOwner?.kind === "user" && targetOwner.userId === executionOwner.userId))
      ) {
        return;
      }
    }

    if (ownerScope.kind === "org") {
      if (backofficeScopeContains(ownerScope, targetScope)) {
        return;
      }

      if (
        targetScope.kind === "user" &&
        principal !== null &&
        resolveBackofficeInternalServiceAuthorityRole(principal) !== null
      ) {
        return;
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
    const deny = (reason = "") => {
      const ownerLabel =
        ownerScope.kind === "system" ? "system" : backofficeScopePathSegment(ownerScope);
      const targetLabel =
        targetScope.kind === "system" ? "system" : backofficeScopePathSegment(targetScope);
      throw new BackofficeForbiddenError(
        `${operation} cannot use ${targetLabel} within ${ownerLabel}${reason}.`,
      );
    };

    switch (ownerScope.kind) {
      case "system":
        return;
      case "org":
        if (backofficeScopeContains(ownerScope, targetScope)) {
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
      // A scope reaches itself and the projects it owns.
      case "app":
      case "project":
        if (backofficeScopeContains(ownerScope, targetScope)) {
          return;
        }
        deny();
        return;
      case "user":
        if (backofficeScopeContains(ownerScope, targetScope)) {
          return;
        }
        // A person's scope also reaches their organizations, for as long as they may emit events
        // there themselves. Checking on every use stops a stored route once they leave.
        if (backofficeScopeRootOwner(targetScope)?.kind === "org") {
          if (await this.#userMayEmitEvents(ownerScope.userId, targetScope)) {
            return;
          }
          deny(", whose owner may not emit events there");
        }
        deny();
        return;
      default:
        throw new Error("Unsupported Backoffice scope kind.", {
          cause: ownerScope satisfies never,
        });
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
    family: { for(scope: BackofficeContextScope): T },
  ): T {
    this.assertObjectAvailable(binding, scope);
    return family.for(scope);
  }
}
