import type { AutomationAuthorityMode } from "@fragno-dev/backoffice-api/v0/automation";
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
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  backofficeScopePathSegment,
  parseBackofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";

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
const noAutomationRouteGrants = [] as const satisfies readonly BackofficePermissionRequirement[];

/**
 * The identity a route's action acts as. An organization automation principal is
 * `automation-route:<routeId>` and only ever acts in its route's scope. A user delegate follows its
 * workflow into every scope its user can reach, so it names its route's scope as well:
 * `automation-route/<scope segment>/<routeId>`. Scope segments encode `/`, so the route ID follows
 * the first one after the prefix.
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
  automationId:
    mode.kind === "organization-automation"
      ? `${AUTOMATION_ROUTE_ACTOR_ID_PREFIX}${routeId}`
      : `${SCOPED_AUTOMATION_ROUTE_ACTOR_ID_PREFIX}${backofficeScopePathSegment(routeScope)}/${routeId}`,
});

export type AutomationRouteAuthorityLookup = (input: {
  scope: BackofficeContextScope;
  routeId: string;
}) => Promise<Pick<AutomationRouteDefinition, "enabled" | "action"> | null>;

/**
 * The route an automation-route actor acts for. Its scope is null for identities that do not name
 * one: organization automation principals, and delegates started before delegates named it, whose
 * route is in the scope they act in.
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

  if (actor.role !== "delegate" || !actor.id.startsWith(SCOPED_AUTOMATION_ROUTE_ACTOR_ID_PREFIX)) {
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
}): Promise<readonly BackofficePermissionRequirement[] | null> {
  const actorRoute = automationRouteFromActor(actor);
  if (!actorRoute) {
    return null;
  }

  const route = await lookupRoute({
    scope: actorRoute.routeScope ?? execution.scope,
    routeId: actorRoute.routeId,
  });
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
  return authority.grants;
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
