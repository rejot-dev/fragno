import type { BackofficeAuthorityResolver } from "./authority-resolver";
import {
  getOrganizationRoleGrants,
  ORGANIZATION_ROLE_PERMISSION_NAMESPACES,
} from "./authority-roles";
import type { AuthObject } from "./object-registry";
import { allBackofficePermissionRequirements, BACKOFFICE_PERMISSION } from "./permissions";

/** Human control-plane changes are never performed under delegated capability grants. */
const PRINCIPAL_ONLY_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  [
    BACKOFFICE_PERMISSION.account.manage,
    BACKOFFICE_PERMISSION.apps.read,
    BACKOFFICE_PERMISSION.apps.manage,
    BACKOFFICE_PERMISSION.org.manage,
  ].map(({ namespace, permission }) => `${namespace}.${permission}`),
);

/**
 * Resolves organization administration from live Auth membership instead of a JWT role snapshot.
 *
 * Organization-role namespaces are replaced by grants for the principal's current roles in the
 * scoped organization. System administrators administer organizations they belong to as owners.
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
      if (
        execution.scope.kind !== "org" ||
        principal.scope !== "internal" ||
        principal.type !== "user" ||
        permissions.length === 0
      ) {
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
      return (await resolver.resolveActorCapabilityGrants(input)).filter(
        ({ namespace, permission }) =>
          !PRINCIPAL_ONLY_PERMISSION_KEYS.has(`${namespace}.${permission}`),
      );
    },
  };
}
