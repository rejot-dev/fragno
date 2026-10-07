import type { BackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import type { AuthObject } from "@/backoffice-runtime/object-registry";
import {
  allBackofficePermissionRequirements,
  BACKOFFICE_PERMISSION,
} from "@/backoffice-runtime/permissions";

/** Installation approval requires live organization authority, not a user JWT's role snapshot. */
export function createAppInstallationAuthorityResolver({
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
      if (!operations.some(({ namespace }) => namespace === "apps")) {
        return permissions;
      }
      const { execution, principal } = input;
      const withoutAppPermissions = permissions.filter(({ namespace }) => namespace !== "apps");
      if (
        execution.scope.kind !== "org" ||
        principal.scope !== "internal" ||
        principal.type !== "user" ||
        permissions.length === 0
      ) {
        return withoutAppPermissions;
      }

      const authority = await auth.getUserOrganizationAuthorityFacts({
        userId: principal.id,
        organizationId: execution.scope.orgId,
      });
      if (!authority.active || authority.organizationRoles === null) {
        return withoutAppPermissions;
      }
      const canManage =
        authority.role === "admin" ||
        authority.organizationRoles.some((role) => role === "owner" || role === "admin");
      return [
        ...withoutAppPermissions,
        BACKOFFICE_PERMISSION.apps.read,
        ...(canManage ? [BACKOFFICE_PERMISSION.apps.manage] : []),
      ];
    },
    async resolveActorCapabilityGrants(input) {
      // Organization approvals are human control-plane operations, never delegated capabilities.
      return (await resolver.resolveActorCapabilityGrants(input)).filter(
        ({ namespace }) => namespace !== "apps",
      );
    },
  };
}
