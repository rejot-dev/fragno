import {
  allBackofficePermissionRequirements,
  isPrincipalOnlyPermission,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";

import type { BackofficeAuthorityResolver } from "./authority-resolver";
import {
  getOrganizationRoleGrants,
  ORGANIZATION_ROLE_PERMISSION_NAMESPACES,
  PERSONAL_SCOPE_GRANTS,
} from "./authority-roles";
import type { AuthObject } from "./object-registry";

/**
 * Resolves organization administration from live Auth membership instead of a JWT role snapshot.
 *
 * Organization-role namespaces are replaced by grants for the principal's current roles in the
 * scoped organization. System administrators administer organizations they belong to as owners.
 * In a user scope, only that user receives the personal grants; administrators do not.
 */
export function createControlPlaneAuthorityResolver({
  resolver,
  auth,
}: {
  resolver: BackofficeAuthorityResolver;
  auth: Pick<AuthObject, "getUserOrganizationAuthorityFacts">;
}): BackofficeAuthorityResolver {
  return {
    async resolvePrincipalPermissions(input, operations = allBackofficePermissionRequirements) {
      const permissions = await resolver.resolvePrincipalPermissions(input, operations);
      // Preserve the existing snapshot policy and avoid Auth reads for unrelated operations.
      if (
        !operations.some(({ namespace }) => ORGANIZATION_ROLE_PERMISSION_NAMESPACES.has(namespace))
      ) {
        return permissions;
      }
      const { execution, principal } = input;
      const withoutOrganizationRolePermissions = permissions.filter(
        ({ namespace }) => !ORGANIZATION_ROLE_PERMISSION_NAMESPACES.has(namespace),
      );
      if (principal.scope !== "internal" || principal.type !== "user" || permissions.length === 0) {
        return withoutOrganizationRolePermissions;
      }
      if (execution.scope.kind === "user") {
        return execution.scope.userId === principal.id
          ? [...withoutOrganizationRolePermissions, ...PERSONAL_SCOPE_GRANTS]
          : withoutOrganizationRolePermissions;
      }
      if (execution.scope.kind !== "org") {
        return withoutOrganizationRolePermissions;
      }

      const authority = await auth.getUserOrganizationAuthorityFacts({
        userId: principal.id,
        organizationId: execution.scope.orgId,
      });
      if (!authority.active || authority.organizationRoles === null) {
        return withoutOrganizationRolePermissions;
      }
      return [
        ...withoutOrganizationRolePermissions,
        ...getOrganizationRoleGrants(
          authority.role === "admin" ? ["owner"] : authority.organizationRoles,
        ),
      ];
    },
    async resolveActorCapabilityGrants(input) {
      // Apps cannot request these, but grants stored before that rule may still hold them.
      return (await resolver.resolveActorCapabilityGrants(input)).filter(
        (grant) => !isPrincipalOnlyPermission(grant),
      );
    },
  };
}
