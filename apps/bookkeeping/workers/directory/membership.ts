import type { OrganizationRole } from "@fragno-dev/backoffice-api/v0/organization";

/**
 * How long Bookkeeping trusts a membership Backoffice confirmed. Someone removed in Backoffice, or
 * given other roles, keeps their access at most this long.
 */
export const MEMBERSHIP_CONFIRMATION_LIFETIME_MS = 60_000;

/** Owners and admins invite people, create administrations, and set up their books. */
export function canManage(roles: OrganizationRole[]): boolean {
  return roles.includes("owner") || roles.includes("admin");
}
