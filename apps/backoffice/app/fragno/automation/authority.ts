import type { BackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import {
  allBackofficePermissionRequirements,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";

import {
  automationActorsSchema,
  automationEntityRefsEqual,
  type AutomationActor,
  type AutomationActors,
} from "./actors";
import type { AutomationEvent } from "./contracts";
import type { AutomationRouteDefinition } from "./routing";

/**
 * Explicit grants narrow the user's authority. `inherit` leaves the user's current permissions
 * unrestricted by the route delegate.
 */
type AutomationUserRouteGrants = readonly BackofficePermissionRequirement[] | "inherit";

/**
 * Selects whose current permissions authorize protected work started by an automation route.
 *
 * A delegate is an additional capability boundary, not an impersonated principal. The kernel
 * requires both the principal and every delegate to grant an operation, so delegation can narrow
 * authority but can never give the principal permissions they do not already have.
 */
export type AutomationAuthorityMode =
  | {
      /**
       * Run on behalf of the internal user principal carried by the triggering event.
       *
       * The user remains the principal and the stable route automation identity is appended as a
       * delegate. For each protected operation, the authority resolver looks up the user's current
       * role, status, and organization membership, then resolves the internal automation delegate
       * from the owning route's current grants. The kernel requires both resulting grant sets to
       * contain the operation. Missing, disabled, or changed routes and missing, invalid, banned,
       * or no-longer-authorized users therefore fail closed. The delegate can restrict but never
       * elevate the user.
       */
      kind: "delegated-user";
      grants: AutomationUserRouteGrants;
    }
  | {
      /**
       * Resolve the external initiator's active identity binding before starting the workflow.
       *
       * The linked internal user becomes the principal and the stable route automation identity is
       * appended as a delegate. Events without an active binding do not start the workflow.
       */
      kind: "linked-user";
      grants: AutomationUserRouteGrants;
    }
  | {
      /**
       * Run as an organization-owned automation independently of the triggering user's authority.
       *
       * The stable `automation-route:<routeId>` identity becomes the principal while the original
       * initiator remains provenance and supplies no authority. For each protected operation, the
       * authority resolver reads the owning route's current grants. The stable route ID provides
       * identity for persistence and auditing while making grant changes and route disablement
       * visible to already-running workflows. The route can therefore continue after its creator or
       * triggering user loses organization access, while remaining limited to its current explicit
       * grants.
       */
      kind: "organization-automation";
      grants: readonly BackofficePermissionRequirement[];
    };

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
    async resolvePrincipalPermissions(input) {
      const routeGrants = await resolveAutomationRouteActorGrants({
        actor: input.principal,
        execution: input.execution,
        lookupRoute,
      });
      return routeGrants ?? (await fallbackResolver.resolvePrincipalPermissions(input));
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
}: {
  scope: BackofficeContextScope;
  actors: unknown;
}): BackofficeExecutionContext => ({
  scope,
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
        actors: event.actors,
      }),
      delegate: automationActor(authority.automationId, "delegate"),
    });
  }

  return {
    scope: event.scope,
    actors: automationActorsSchema.parse({
      initiator: event.actors.initiator,
      principal: automationActor(authority.automationId, "principal"),
      delegation: event.actors.delegation,
    }),
  };
};
