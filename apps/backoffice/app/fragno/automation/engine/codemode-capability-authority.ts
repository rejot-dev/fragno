import {
  type AutomationActors,
  automationEntityRefsEqual,
} from "@fragno-dev/backoffice-api/v0/automation";
import {
  type BackofficePermissionRequirement,
  isPrincipalOnlyPermission,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";

import { codemodeCapabilityActorRun, codemodeWorkflowParamsSchema } from "./codemode-invocation";

export type CodemodeCapabilityGrantsLookup = (input: {
  ownerScope: BackofficeContextScope;
  instanceId: string;
  actor: AutomationActors["delegation"][number];
}) => Promise<readonly BackofficePermissionRequirement[]>;

/**
 * Resolves a codemode capability delegate from the run it names, wherever the work that run caused
 * goes: into the objects it calls, the workflows it starts, and the events it fires. A capability
 * delegate that names no run, or a run that no longer exists, grants nothing, and none grants what
 * only a person may do.
 */
export function createCodemodeCapabilityAuthorityResolver({
  resolver,
  lookupCapabilityGrants,
}: {
  resolver: BackofficeAuthorityResolver;
  lookupCapabilityGrants: CodemodeCapabilityGrantsLookup;
}): BackofficeAuthorityResolver {
  return {
    resolvePrincipalPermissions: async (input, operations) =>
      await resolver.resolvePrincipalPermissions(input, operations),
    async resolveActorCapabilityGrants(input) {
      const { actor } = input;
      if (actor.scope !== "internal" || actor.type !== "capability") {
        return await resolver.resolveActorCapabilityGrants(input);
      }
      const run = codemodeCapabilityActorRun(actor);
      const grants = run ? await lookupCapabilityGrants({ ...run, actor }) : [];
      return grants.filter((grant) => !isPrincipalOnlyPermission(grant));
    },
  };
}

/** The grants a codemode run's stored parameters hold for `actor`. */
export function codemodeRunCapabilityGrants(
  params: unknown,
  actor: AutomationActors["delegation"][number],
): readonly BackofficePermissionRequirement[] {
  // Unreadable params fail resolution rather than read as a run that granted nothing.
  return (
    codemodeWorkflowParamsSchema
      .parse(params)
      .execution.capabilityGrants.find((grant) => automationEntityRefsEqual(grant.actor, actor))
      ?.permissions ?? []
  );
}
