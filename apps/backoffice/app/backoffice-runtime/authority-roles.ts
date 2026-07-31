import type { Role } from "@fragno-dev/auth";

import type { AutomationEntityRef } from "@/fragno/automation/actors";

import type { BackofficeContextScope } from "./context";
import { BACKOFFICE_PERMISSION, type BackofficePermissionRequirement } from "./permissions";

const USER_AUTHORITY_ROLE_GRANTS = {
  "system-administrator": [BACKOFFICE_PERMISSION.store.modify],
  "user-owner": [
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
  ],
  "organization-member": [
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
  ],
} as const satisfies Record<string, readonly BackofficePermissionRequirement[]>;

/**
 * Internal service identities recognized by Backoffice authorization and their explicit grants.
 *
 * This table is the canonical service-identity catalog. Adding an actor type here both recognizes it
 * as an internal service and requires the author to choose its current finite permission grants.
 */
const INTERNAL_SERVICE_AUTHORITY_ROLE_GRANTS = {
  automation: [
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
  ],
  agent: [
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
  ],
  capability: [
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
  ],
  object: [
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
  ],
  system: [
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
  ],
} as const satisfies Record<string, readonly BackofficePermissionRequirement[]>;

export type BackofficeUserAuthorityRole = keyof typeof USER_AUTHORITY_ROLE_GRANTS;
export type BackofficeInternalServiceAuthorityRole =
  keyof typeof INTERNAL_SERVICE_AUTHORITY_ROLE_GRANTS;

/**
 * Explicit grants for operations that currently execute through `BackofficeKernel.invoke()`.
 *
 * These are Backoffice authorization roles, not persisted actor roles or Auth organization role
 * names. Each later action migration must update only the roles that should receive its permission;
 * adding a permission to the catalog grants it to no role automatically.
 */
export const BACKOFFICE_AUTHORITY_ROLE_GRANTS = {
  ...USER_AUTHORITY_ROLE_GRANTS,
  ...INTERNAL_SERVICE_AUTHORITY_ROLE_GRANTS,
} as const satisfies Record<string, readonly BackofficePermissionRequirement[]>;

type BackofficeAuthorityRole = keyof typeof BACKOFFICE_AUTHORITY_ROLE_GRANTS;

/** Maps verified or current user facts to the one Backoffice role available in a scope. */
export const resolveBackofficeUserAuthorityRole = (
  authority: Readonly<{
    userId: string;
    role: Role;
    organizationIds: readonly string[];
  }>,
  scope: BackofficeContextScope,
): BackofficeUserAuthorityRole | null => {
  switch (scope.kind) {
    case "system":
      return authority.role === "admin" ? "system-administrator" : null;
    case "user":
      return authority.userId === scope.userId ? "user-owner" : null;
    case "org":
    case "project":
      return authority.organizationIds.includes(scope.orgId) ? "organization-member" : null;
  }

  return null;
};

export const resolveBackofficeInternalServiceAuthorityRole = ({
  scope: identityScope,
  type: actorType,
}: Pick<AutomationEntityRef, "scope" | "type">): BackofficeInternalServiceAuthorityRole | null => {
  if (
    identityScope !== "internal" ||
    !Object.hasOwn(INTERNAL_SERVICE_AUTHORITY_ROLE_GRANTS, actorType)
  ) {
    return null;
  }

  return actorType as BackofficeInternalServiceAuthorityRole;
};

export const getBackofficeAuthorityRoleGrants = (
  role: BackofficeAuthorityRole,
): readonly BackofficePermissionRequirement[] => BACKOFFICE_AUTHORITY_ROLE_GRANTS[role];
