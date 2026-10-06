import { z } from "zod";

import {
  backofficePermissionRequirementSchema,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";

/** App permission declarations and grants are sets; duplicate entries are malformed input. */
export const appPermissionsSchema = z
  .array(backofficePermissionRequirementSchema)
  .refine(
    (permissions) =>
      new Set(permissions.map(({ namespace, permission }) => `${namespace}.${permission}`)).size ===
      permissions.length,
    "Backoffice app permissions must not contain duplicates.",
  );

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
