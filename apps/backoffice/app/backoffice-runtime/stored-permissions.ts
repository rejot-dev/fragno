import {
  allBackofficePermissionRequirements,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";

function isBackofficePermissionRequirement(input: {
  namespace: string;
  permission: string;
}): input is BackofficePermissionRequirement {
  return allBackofficePermissionRequirements.some(
    (requirement) =>
      requirement.namespace === input.namespace && requirement.permission === input.permission,
  );
}

/**
 * Stored permission lists can name permissions removed since they were written. Those authorize
 * nothing, so readers of stored grants drop them instead of failing to parse the whole record.
 */
export function knownBackofficePermissions(
  permissions: readonly { namespace: string; permission: string }[],
): BackofficePermissionRequirement[] {
  return permissions.filter(isBackofficePermissionRequirement);
}
