import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";

/** App permission equality is independent of declaration or approval order. */
export function appPermissionsEqual(
  left: readonly BackofficePermissionRequirement[],
  right: readonly BackofficePermissionRequirement[],
): boolean {
  return (
    left.length === right.length &&
    left.every((permission) =>
      right.some(
        (candidate) =>
          candidate.namespace === permission.namespace &&
          candidate.permission === permission.permission,
      ),
    )
  );
}
