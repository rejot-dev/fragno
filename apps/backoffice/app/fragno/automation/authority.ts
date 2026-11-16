import type {
  AutomationAuthorityMode,
  AutomationGrantedConnectionScope,
  AutomationRouteGrant,
} from "@fragno-dev/backoffice-api/v0/automation";
import {
  automationActorsSchema,
  automationEntityRefsEqual,
  automationRouteActionAuthority,
  type AutomationActor,
  type AutomationActors,
  type AutomationRouteDefinition,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import {
  allBackofficePermissionRequirements,
  BACKOFFICE_PERMISSION,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  backofficeScopePathSegment,
  backofficeScopeProjectOwner,
  parseBackofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type {
  BackofficeAuthorityResolver,
  BackofficeGrant,
} from "@/backoffice-runtime/authority-resolver";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import {
  BackofficeForbiddenError,
  type BackofficeConnectionResource,
  type BackofficeKernelAuthorizationRequirement,
} from "@/backoffice-runtime/kernel";

import { scopeIdentity } from "./forward-accepts";

export type AutomationRuntimeAuthority = Readonly<{
  mode: AutomationAuthorityMode;
  automationId: string;
}>;

export type AutomationAuthorityModeFailureReason =
  | "delegated-user-principal-required"
  | "delegated-user-principal-invalid"
  | "linked-user-external-initiator-required"
  | "linked-user-principal-forbidden"
  | "scheduled-user-principal-forbidden";

export class AutomationAuthorityModeError extends Error {
  constructor(readonly reason: AutomationAuthorityModeFailureReason) {
    super(reason);
    this.name = "AutomationAuthorityModeError";
  }
}

const AUTOMATION_ROUTE_ACTOR_ID_PREFIX = "automation-route:";
const SCOPED_AUTOMATION_ROUTE_ACTOR_ID_PREFIX = "automation-route/";
const noAutomationRouteGrants = [] as const satisfies readonly BackofficeGrant[];

/**
 * The identity a route's action acts as: `automation-route/<scope segment>/<routeId>`. Its workflow
 * follows calls into other scopes, such as an organization automation into the organization's
 * projects, and its grants stay those of the route in the scope it names. Scope segments encode
 * `/`, so the route ID follows the first one after the prefix.
 */
export const automationRouteAuthority = ({
  routeId,
  routeScope,
  mode,
}: {
  routeId: string;
  routeScope: BackofficeContextScope;
  mode: AutomationAuthorityMode;
}): AutomationRuntimeAuthority => ({
  mode,
  automationId: `${SCOPED_AUTOMATION_ROUTE_ACTOR_ID_PREFIX}${backofficeScopePathSegment(routeScope)}/${routeId}`,
});

export type AutomationRouteAuthorityLookup = (input: {
  scope: BackofficeContextScope;
  routeId: string;
}) => Promise<Pick<AutomationRouteDefinition, "enabled" | "action"> | null>;

/**
 * The route an automation-route actor acts for. Its scope is null for the unscoped identities that
 * runs started before actors named their route's scope still carry; their route is looked up in the
 * scope they act in.
 */
function automationRouteFromActor(
  actor: AutomationActor<"principal" | "delegate">,
): { routeId: string; routeScope: BackofficeContextScope | null } | null {
  if (actor.scope !== "internal" || actor.type !== "automation") {
    return null;
  }

  if (actor.id.startsWith(AUTOMATION_ROUTE_ACTOR_ID_PREFIX)) {
    const routeId = actor.id.slice(AUTOMATION_ROUTE_ACTOR_ID_PREFIX.length);
    return routeId.length > 0 ? { routeId, routeScope: null } : null;
  }

  if (!actor.id.startsWith(SCOPED_AUTOMATION_ROUTE_ACTOR_ID_PREFIX)) {
    return null;
  }
  const scopedRoute = actor.id.slice(SCOPED_AUTOMATION_ROUTE_ACTOR_ID_PREFIX.length);
  const separator = scopedRoute.indexOf("/");
  const routeId = scopedRoute.slice(separator + 1);
  if (separator < 0 || routeId.length === 0) {
    return null;
  }
  return {
    routeId,
    routeScope: parseBackofficeScopePathSegment(scopedRoute.slice(0, separator)),
  };
}

/**
 * The scope a route grants a connection in, as a codemode `context` handle in the route's scope
 * reaches it; null for a project of a scope that owns none, such as System.
 */
function grantedConnectionScope(
  routeScope: BackofficeContextScope,
  scope: AutomationGrantedConnectionScope,
): BackofficeContextScope | null {
  switch (scope.kind) {
    case "current":
      return routeScope;
    case "org":
      return { kind: "org", orgId: scope.orgId, jurisdiction: null };
    case "user":
      return { kind: "user", userId: scope.userId, jurisdiction: null };
    case "project": {
      const owner = backofficeScopeProjectOwner(routeScope);
      return owner && { kind: "project", owner, projectId: scope.projectId };
    }
    default:
      throw new Error("Unsupported granted connection scope.", { cause: scope satisfies never });
  }
}

/** A route's grants as the kernel checks them, its connections in the scopes they are in. */
function routeGrants(
  routeScope: BackofficeContextScope,
  grants: readonly AutomationRouteGrant[],
): BackofficeGrant[] {
  return grants.map((grant) =>
    "connections" in grant
      ? {
          namespace: grant.namespace,
          permission: grant.permission,
          connections: grant.connections.flatMap(({ scope, connectionId }) => {
            const resolved = grantedConnectionScope(routeScope, scope);
            return resolved ? [{ scope: resolved, connectionId }] : [];
          }),
        }
      : grant,
  );
}

/**
 * Whether a route's own scope reaches `scope` without a user: the scope itself, or a project it
 * owns. A person's role in such a project is their role in the route's scope.
 */
function routeScopeReaches(routeScope: BackofficeContextScope, scope: BackofficeContextScope) {
  return (
    scopeIdentity(scope) === scopeIdentity(routeScope) ||
    (scope.kind === "project" && scopeIdentity(scope.owner) === scopeIdentity(routeScope))
  );
}

/**
 * What saving a route asks of whoever saves it: every permission it grants, and execute on every
 * connection it grants. Whoever saves a route, and every delegate they act through, must hold what
 * it grants: a user-backed route can act as someone the saver acts for, such as a personal
 * schedule acting as the scope's owner. Its user's own permissions in a connection's scope are
 * resolved on every call, so saving asks nothing there. An organization automation acts only in
 * its route's scope and the projects that scope owns, so granting it a connection elsewhere is
 * refused.
 */
export function automationRouteGrantRequirements({
  routeId,
  routeScope,
  authorityKind,
  grants,
}: {
  routeId: string;
  routeScope: BackofficeContextScope;
  authorityKind: AutomationAuthorityMode["kind"];
  grants: readonly AutomationRouteGrant[];
}): BackofficeKernelAuthorizationRequirement[] {
  return routeGrants(routeScope, grants).flatMap(
    (grant): BackofficeKernelAuthorizationRequirement[] => {
      if (!("connections" in grant)) {
        return [{ operation: grant, resource: { kind: "automation-route-grant", routeId, grant } }];
      }
      return grant.connections.map((connection) => {
        if (
          authorityKind === "organization-automation" &&
          !routeScopeReaches(routeScope, connection.scope)
        ) {
          throw new BackofficeForbiddenError(
            `An organization automation acts only in its route's scope and the projects it owns, so it cannot be granted ${connection.connectionId} in ${scopeIdentity(connection.scope)}.`,
            "context-access-denied",
          );
        }
        return {
          operation: BACKOFFICE_PERMISSION.integrations.execute,
          resource: {
            kind: "integration-connection",
            ...connection,
          } satisfies BackofficeConnectionResource,
        };
      });
    },
  );
}

/** Returns the owning route id only for stable automation-route actor identities. */
export function automationRouteIdFromActor(
  actor: AutomationActor<"principal" | "delegate">,
): string | null {
  return automationRouteFromActor(actor)?.routeId ?? null;
}

async function resolveAutomationRouteActorGrants({
  actor,
  execution,
  lookupRoute,
}: {
  actor: AutomationActor<"principal" | "delegate">;
  execution: BackofficeExecutionContext;
  lookupRoute: AutomationRouteAuthorityLookup;
}): Promise<readonly BackofficeGrant[] | null> {
  const actorRoute = automationRouteFromActor(actor);
  if (!actorRoute) {
    return null;
  }

  const routeScope = actorRoute.routeScope ?? execution.scope;
  const route = await lookupRoute({ scope: routeScope, routeId: actorRoute.routeId });
  const authority = route?.enabled ? automationRouteActionAuthority(route.action) : null;
  if (!authority) {
    return noAutomationRouteGrants;
  }

  const roleMatchesAuthorityMode =
    (actor.role === "principal" && authority.kind === "organization-automation") ||
    (actor.role === "delegate" &&
      (authority.kind === "delegated-user" || authority.kind === "linked-user"));
  if (!roleMatchesAuthorityMode) {
    return noAutomationRouteGrants;
  }
  if (authority.grants === "inherit") {
    return allBackofficePermissionRequirements;
  }
  return routeGrants(routeScope, authority.grants);
}

/** Resolves automation principals and delegates from their owning route's current grant set. */
export function createAutomationRouteAuthorityResolver({
  fallbackResolver,
  lookupRoute,
}: {
  fallbackResolver: BackofficeAuthorityResolver;
  lookupRoute: AutomationRouteAuthorityLookup;
}): BackofficeAuthorityResolver {
  return {
    async resolvePrincipalPermissions(input, operations) {
      const routeGrants = await resolveAutomationRouteActorGrants({
        actor: input.principal,
        execution: input.execution,
        lookupRoute,
      });
      return routeGrants ?? (await fallbackResolver.resolvePrincipalPermissions(input, operations));
    },
    async resolveActorCapabilityGrants(input) {
      if (input.actor.role !== "delegate") {
        return await fallbackResolver.resolveActorCapabilityGrants(input);
      }
      const routeGrants = await resolveAutomationRouteActorGrants({
        actor: input.actor,
        execution: input.execution,
        lookupRoute,
      });
      return routeGrants ?? (await fallbackResolver.resolveActorCapabilityGrants(input));
    },
  };
}

const automationActor = <TRole extends "principal" | "delegate">(
  automationId: string,
  role: TRole,
): AutomationActor<TRole> => ({
  scope: "internal",
  type: "automation",
  id: automationId,
  role,
});

export const createAutomationExecutionFromActors = ({
  scope,
  actors,
  scopeRestriction,
}: {
  scope: BackofficeContextScope;
  actors: unknown;
  scopeRestriction: BackofficeContextScope | null;
}): BackofficeExecutionContext => ({
  kind: "deferred",
  scope,
  scopeRestriction,
  actors: automationActorsSchema.parse(actors),
});

export function linkAutomationEventToUser({
  event,
  userId,
}: {
  event: AutomationEvent;
  userId: string;
}): AutomationEvent {
  if (event.actors.initiator.scope !== "external") {
    throw new AutomationAuthorityModeError("linked-user-external-initiator-required");
  }
  if (event.actors.principal !== null) {
    throw new AutomationAuthorityModeError("linked-user-principal-forbidden");
  }

  return {
    ...event,
    actors: automationActorsSchema.parse({
      ...event.actors,
      principal: {
        scope: "internal",
        type: "user",
        id: userId,
        role: "principal",
      },
    }),
  };
}

/** Names the user a scheduled route's own action acts for on the schedule event it received. */
export function actForScheduledRouteUser({
  event,
  userId,
}: {
  event: AutomationEvent;
  userId: string;
}): AutomationEvent {
  if (event.actors.principal !== null) {
    throw new AutomationAuthorityModeError("scheduled-user-principal-forbidden");
  }
  return {
    ...event,
    actors: automationActorsSchema.parse({
      ...event.actors,
      principal: { scope: "internal", type: "user", id: userId, role: "principal" },
    }),
  };
}

/** Appends a trusted delegate that every later protected operation must authorize. */
export const appendAutomationDelegate = ({
  execution,
  delegate,
}: {
  execution: BackofficeExecutionContext;
  delegate: AutomationActors["delegation"][number];
}): BackofficeExecutionContext => {
  if (execution.kind === "request") {
    throw new Error("Delegation requires deferred execution with current authority.");
  }
  const actorAlreadyPresent = [
    execution.actors.initiator,
    ...(execution.actors.principal ? [execution.actors.principal] : []),
    ...execution.actors.delegation,
  ].some((actor) => automationEntityRefsEqual(actor, delegate));
  if (actorAlreadyPresent) {
    return execution;
  }

  return {
    ...execution,
    actors: automationActorsSchema.parse({
      ...execution.actors,
      delegation: [...execution.actors.delegation, delegate],
    }),
  };
};

export const createAutomationRuntimeExecution = ({
  event,
  authority,
}: {
  event: AutomationEvent;
  authority: AutomationRuntimeAuthority;
}): BackofficeExecutionContext => {
  if (authority.mode.kind === "delegated-user" || authority.mode.kind === "linked-user") {
    const principal = event.actors.principal;
    if (!principal) {
      throw new AutomationAuthorityModeError("delegated-user-principal-required");
    }
    if (principal.scope !== "internal" || principal.type !== "user") {
      throw new AutomationAuthorityModeError("delegated-user-principal-invalid");
    }

    return appendAutomationDelegate({
      execution: createAutomationExecutionFromActors({
        scope: event.scope,
        scopeRestriction: event.scopeRestriction,
        actors: event.actors,
      }),
      delegate: automationActor(authority.automationId, "delegate"),
    });
  }

  return {
    kind: "deferred",
    scope: event.scope,
    // Organization automation is an explicit transition to the route's own live authority.
    scopeRestriction: null,
    actors: automationActorsSchema.parse({
      initiator: event.actors.initiator,
      principal: automationActor(authority.automationId, "principal"),
      delegation: event.actors.delegation,
    }),
  };
};
