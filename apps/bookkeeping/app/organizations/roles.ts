import type { OrganizationRole } from "@fragno-dev/backoffice-api/v0/organization";

/** Backoffice's roles, as Bookkeeping names them. */
export const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/** The highest of someone's roles, which Bookkeeping shows as theirs. */
export function highestRole(roles: OrganizationRole[]): OrganizationRole {
  // Backoffice gives every member at least one role.
  return (["owner", "admin", "member"] as const).find((role) => roles.includes(role))!;
}
