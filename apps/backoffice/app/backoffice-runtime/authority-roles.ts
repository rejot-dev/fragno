import { BACKOFFICE_PERMISSION, type BackofficePermissionRequirement } from "./permissions";

/**
 * Roles resolved from current identity state before the kernel evaluates an action.
 *
 * These are Backoffice authorization roles, not persisted actor roles or Auth organization role
 * names. Adding a permission to the catalog does not grant it here automatically.
 */
export type BackofficeAuthorityRole =
  | "user-owner"
  | "organization-member"
  | "automation"
  | "agent"
  | "capability"
  | "object"
  | "system";

/**
 * Explicit grants for operations that currently execute through `BackofficeKernel.invoke()`.
 *
 * Each later action migration must update only the roles that should receive its permission. This
 * prevents a newly cataloged permission from silently reaching every principal or delegated actor.
 */
export const BACKOFFICE_AUTHORITY_ROLE_GRANTS = {
  "user-owner": [BACKOFFICE_PERMISSION.otp.create, BACKOFFICE_PERMISSION.telegram.send],
  "organization-member": [BACKOFFICE_PERMISSION.otp.create, BACKOFFICE_PERMISSION.telegram.send],
  automation: [BACKOFFICE_PERMISSION.otp.create, BACKOFFICE_PERMISSION.telegram.send],
  agent: [BACKOFFICE_PERMISSION.otp.create, BACKOFFICE_PERMISSION.telegram.send],
  capability: [BACKOFFICE_PERMISSION.otp.create, BACKOFFICE_PERMISSION.telegram.send],
  object: [BACKOFFICE_PERMISSION.otp.create, BACKOFFICE_PERMISSION.telegram.send],
  system: [BACKOFFICE_PERMISSION.otp.create, BACKOFFICE_PERMISSION.telegram.send],
} as const satisfies Record<BackofficeAuthorityRole, readonly BackofficePermissionRequirement[]>;

export const getBackofficeAuthorityRoleGrants = (
  role: BackofficeAuthorityRole,
): readonly BackofficePermissionRequirement[] => BACKOFFICE_AUTHORITY_ROLE_GRANTS[role];
