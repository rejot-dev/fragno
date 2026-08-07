import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";

import {
  automationActorsSchema,
  automationEntityRefsEqual,
  type AutomationActor,
  type AutomationActors,
} from "./actors";
import type { AutomationEvent } from "./contracts";

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
       * role, status, and organization membership, then maps the internal automation delegate to
       * the shared `automation` role through `resolveBackofficeInternalServiceAuthorityRole()`.
       * The kernel requires both resulting grant sets to contain the operation. Missing, invalid,
       * banned, or no-longer-authorized users therefore fail closed, and the delegate can restrict
       * but never elevate the user.
       */
      kind: "delegated-user";
    }
  | {
      /**
       * Run as an organization-owned automation independently of the triggering user's authority.
       *
       * The stable `automation-route:<routeId>` identity becomes the principal while the original
       * initiator remains provenance and supplies no authority. For each protected operation, the
       * authority resolver maps the principal's internal `type: "automation"` through
       * `resolveBackofficeInternalServiceAuthorityRole()` to the shared `automation` grants defined
       * by `INTERNAL_SERVICE_AUTHORITY_ROLE_GRANTS` in `authority-roles.ts`. The route ID provides a
       * stable identity for persistence and auditing; it does not currently select per-route grants.
       * The route can therefore continue after its creator or triggering user loses organization
       * access, while remaining limited to the finite shared automation permission set.
       */
      kind: "organization-automation";
    };

export type AutomationRuntimeAuthority = Readonly<{
  mode: AutomationAuthorityMode;
  automationId: string;
}>;

export type AutomationAuthorityModeFailureReason =
  | "delegated-user-principal-required"
  | "delegated-user-principal-invalid";

export class AutomationAuthorityModeError extends Error {
  constructor(readonly reason: AutomationAuthorityModeFailureReason) {
    super(reason);
    this.name = "AutomationAuthorityModeError";
  }
}

export const automationRouteAuthority = ({
  routeId,
  mode,
}: {
  routeId: string;
  mode: AutomationAuthorityMode;
}): AutomationRuntimeAuthority => ({
  mode,
  automationId: `automation-route:${routeId}`,
});

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
  if (authority.mode.kind === "delegated-user") {
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
