import type {
  OrganizationAccessRecord,
  OrganizationRole,
} from "@fragno-dev/backoffice-api/v0/organization";

import type { MembershipThrough } from "./directory";

/**
 * How long Bookkeeping trusts a membership Backoffice confirmed. Someone removed in Backoffice, or
 * given other roles, keeps their access at most this long.
 */
export const MEMBERSHIP_CONFIRMATION_LIFETIME_MS = 60_000;

/** Owners and admins invite people, create administrations, and set up their books. */
export function canManage(roles: OrganizationRole[]): boolean {
  return roles.includes("owner") || roles.includes("admin");
}

/**
 * How Backoffice says someone acts in an organization: as a member, or through the organization
 * managing it, which in Bookkeeping is a client's firm.
 */
export function membershipThrough(through: OrganizationAccessRecord["through"]): MembershipThrough {
  return through === "membership" ? "membership" : "firm";
}
