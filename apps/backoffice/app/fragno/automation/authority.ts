import type { AutomationAuthorityMode } from "@fragno-dev/backoffice-api/v0/automation";
import {
  automationActorsSchema,
  automationEntityRefsEqual,
  type AutomationActor,
  type AutomationActors,
  type AutomationRouteDefinition,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import {
  allBackofficePermissionRequirements,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

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
  | "linked-user-principal-forbidden";

export class AutomationAuthorityModeError extends Error {
  constructor(readonly reason: AutomationAuthorityModeFailureReason) {
    super(reason);
    this.name = "AutomationAuthorityModeError";
  }
}

const AUTOMATION_ROUTE_ACTOR_ID_PREFIX = "automation-route:";
const noAutomationRouteGrants = [] as const satisfies readonly BackofficePermissionRequirement[];

export const automationRouteAuthority = ({
  routeId,
  mode,
}: {
  routeId: string;
  mode: AutomationAuthorityMode;
}): AutomationRuntimeAuthority => ({
  mode,
  automationId: `${AUTOMATION_ROUTE_ACTOR_ID_PREFIX}${routeId}`,
});

export type AutomationRouteAuthorityLookup = (input: {
  scope: BackofficeContextScope;
  routeId: string;
}) => Promise<Pick<AutomationRouteDefinition, "enabled" | "action"> | null>;

/** Returns the owning route id only for stable automation-route actor identities. */
export function automationRouteIdFromActor(
  actor: AutomationActor<"principal" | "delegate">,
): string | null {
  if (
    actor.scope !== "internal" ||
    actor.type !== "automation" ||
    !actor.id.startsWith(AUTOMATION_ROUTE_ACTOR_ID_PREFIX)
  ) {
    return null;
  }

  const routeId = actor.id.slice(AUTOMATION_ROUTE_ACTOR_ID_PREFIX.length);
  return routeId.length > 0 ? routeId : null;
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
  const routeId = automationRouteIdFromActor(actor);
  if (!routeId) {
    return null;
  }

  const route = await lookupRoute({ scope: execution.scope, routeId });
  if (!route?.enabled || route.action.kind !== "start_workflow") {
    return noAutomationRouteGrants;
  }

  const authority = route.action.authority;
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
