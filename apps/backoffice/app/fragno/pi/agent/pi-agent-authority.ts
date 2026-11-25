import {
  type BackofficePermissionRequirement,
  isPrincipalOnlyPermission,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  parseBackofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";

import { builtInPiAgentDefinition, piAgentDefinitionPermissions } from "./agent-definitions";

export type PiAgentPermissionsLookup = (input: {
  scope: BackofficeContextScope;
  agentName: string;
}) => Promise<readonly BackofficePermissionRequirement[]>;

/**
 * Resolves an agent delegate from its definition as it is now, wherever the work it caused runs:
 * in another object its turn calls, and in the workflows, routes, and events its turns leave
 * behind. A turn's own runtime narrows it to the definition it was admitted with instead. Built-in
 * agents are defined in code, so only scopes' own agents are looked up. An agent never holds what
 * only a person may do.
 */
export function createPiAgentAuthorityResolver({
  resolver,
  lookupAgentPermissions,
}: {
  resolver: BackofficeAuthorityResolver;
  lookupAgentPermissions: PiAgentPermissionsLookup;
}): BackofficeAuthorityResolver {
  return {
    resolvePrincipalPermissions: async (input, operations) =>
      await resolver.resolvePrincipalPermissions(input, operations),
    async resolveActorCapabilityGrants(input) {
      const { actor } = input;
      if (actor.scope !== "internal" || actor.type !== "pi-agent") {
        return await resolver.resolveActorCapabilityGrants(input);
      }
      // Scope segments encode `/`, so the agent's name follows the last one.
      const separator = actor.id.lastIndexOf("/");
      const agentName = actor.id.slice(separator + 1);
      const builtIn = builtInPiAgentDefinition(agentName);
      const permissions = builtIn
        ? piAgentDefinitionPermissions(builtIn)
        : await lookupAgentPermissions({
            scope: parseBackofficeScopePathSegment(actor.id.slice(0, separator)),
            agentName,
          });
      return permissions.filter((permission) => !isPrincipalOnlyPermission(permission));
    },
  };
}
