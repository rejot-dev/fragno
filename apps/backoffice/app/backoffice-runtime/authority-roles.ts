import type { OrganizationRole, Role } from "@/fragno/auth/contracts";
import type { AutomationEntityRef } from "@/fragno/automation/actors";

import type { BackofficeContextScope } from "./context";
import {
  allBackofficePermissionRequirements,
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "./permissions";

/**
 * Permissions that stay with system administrators and trusted internal services. Organization
 * members receive every other permission, including permissions added to the catalog later, except
 * organization-role permissions, which resolve from live membership.
 */
const ADMINISTRATION_PERMISSION_REQUIREMENTS: readonly BackofficePermissionRequirement[] = [
  ...Object.values(BACKOFFICE_PERMISSION.admin),
  BACKOFFICE_PERMISSION.internal.manage,
  // Binding or revoking an external identity for an arbitrary user lets the caller act as them.
  BACKOFFICE_PERMISSION.identity.bind,
  BACKOFFICE_PERMISSION.identity.revoke,
];

/**
 * Grants conferred by live Better Auth organization roles.
 *
 * Permissions in these namespaces come only from current membership, never from token snapshots
 * or Backoffice user roles. Stored role names outside this table grant nothing.
 */
const ORGANIZATION_ROLE_GRANTS = {
  owner: [
    BACKOFFICE_PERMISSION.apps.read,
    BACKOFFICE_PERMISSION.apps.manage,
    BACKOFFICE_PERMISSION.org.read,
    BACKOFFICE_PERMISSION.org.manage,
  ],
  admin: [
    BACKOFFICE_PERMISSION.apps.read,
    BACKOFFICE_PERMISSION.apps.manage,
    BACKOFFICE_PERMISSION.org.read,
    BACKOFFICE_PERMISSION.org.manage,
  ],
  member: [BACKOFFICE_PERMISSION.apps.read, BACKOFFICE_PERMISSION.org.read],
} as const satisfies Record<OrganizationRole, readonly BackofficePermissionRequirement[]>;

export const ORGANIZATION_ROLE_PERMISSION_NAMESPACES: ReadonlySet<string> = new Set(
  Object.values(ORGANIZATION_ROLE_GRANTS).flatMap((grants) =>
    grants.map(({ namespace }) => namespace),
  ),
);

const organizationMemberPermissionRequirements = allBackofficePermissionRequirements.filter(
  (requirement) =>
    !ADMINISTRATION_PERMISSION_REQUIREMENTS.includes(requirement) &&
    !ORGANIZATION_ROLE_PERMISSION_NAMESPACES.has(requirement.namespace),
);

/**
 * Roles for human users, chosen per scope by `resolveBackofficeUserAuthorityRole`.
 *
 * `user-owner` and `organization-member` are the same non-admin user in different scopes:
 * `user-owner` applies in the user's own personal scope, while `organization-member` applies in an
 * organization or project scope of the user's organization. The personal scope keeps an explicit,
 * narrower grant; organization members receive every non-administration permission. Admins resolve
 * to `system-administrator` in either scope.
 */
const USER_AUTHORITY_ROLE_GRANTS = {
  "system-administrator": allBackofficePermissionRequirements,
  "user-owner": [
    BACKOFFICE_PERMISSION.account.manage,
    BACKOFFICE_PERMISSION.account.read,
    BACKOFFICE_PERMISSION.marketplace.publish,
    BACKOFFICE_PERMISSION.api.connectionsRead,
    BACKOFFICE_PERMISSION.capabilities.read,
    BACKOFFICE_PERMISSION.events.emit,
    BACKOFFICE_PERMISSION.events.manage,
    BACKOFFICE_PERMISSION.events.read,
    BACKOFFICE_PERMISSION.hooks.read,
    BACKOFFICE_PERMISSION.identity.read,
    BACKOFFICE_PERMISSION.marketplace.read,
    BACKOFFICE_PERMISSION.packages.read,
    BACKOFFICE_PERMISSION.packages.install,
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.pi.modify,
    BACKOFFICE_PERMISSION.pi.read,
    BACKOFFICE_PERMISSION.router.modify,
    BACKOFFICE_PERMISSION.router.read,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.store.read,
    BACKOFFICE_PERMISSION.telegram.send,
    BACKOFFICE_PERMISSION.upload.modify,
    BACKOFFICE_PERMISSION.upload.read,
    BACKOFFICE_PERMISSION.workflow.executeCode,
    BACKOFFICE_PERMISSION.workflow.modify,
    BACKOFFICE_PERMISSION.workflow.read,
  ],
  "organization-member": organizationMemberPermissionRequirements,
} as const satisfies Record<string, readonly BackofficePermissionRequirement[]>;

/**
 * Internal service identities recognized by Backoffice authorization and their explicit grants.
 *
 * This table is the canonical service-identity catalog. Adding an actor type here both recognizes it
 * as an internal service and requires the author to choose its current finite permission grants.
 */
const INTERNAL_SERVICE_AUTHORITY_ROLE_GRANTS = {
  // Non-route automation services retain explicit infrastructure grants. Stable route actors are
  // denied by the base resolver and resolved from current route state by the Automations object.
  automation: allBackofficePermissionRequirements,
  agent: [
    BACKOFFICE_PERMISSION.marketplace.publish,
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
    BACKOFFICE_PERMISSION.upload.modify,
    BACKOFFICE_PERMISSION.upload.read,
  ],
  // Runtime capability grants remain the narrower per-execution boundary.
  capability: allBackofficePermissionRequirements,
  object: [
    BACKOFFICE_PERMISSION.marketplace.publish,
    BACKOFFICE_PERMISSION.identity.bind,
    BACKOFFICE_PERMISSION.identity.resolve,
    BACKOFFICE_PERMISSION.identity.revoke,
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
    BACKOFFICE_PERMISSION.upload.modify,
    BACKOFFICE_PERMISSION.upload.read,
  ],
  system: [
    BACKOFFICE_PERMISSION.marketplace.publish,
    BACKOFFICE_PERMISSION.identity.bind,
    BACKOFFICE_PERMISSION.identity.resolve,
    BACKOFFICE_PERMISSION.identity.revoke,
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
    BACKOFFICE_PERMISSION.upload.modify,
    BACKOFFICE_PERMISSION.upload.read,
  ],
} as const satisfies Record<string, readonly BackofficePermissionRequirement[]>;

export type BackofficeUserAuthorityRole = keyof typeof USER_AUTHORITY_ROLE_GRANTS;
export type BackofficeInternalServiceAuthorityRole =
  keyof typeof INTERNAL_SERVICE_AUTHORITY_ROLE_GRANTS;

/**
 * Explicit grants for operations that currently execute through `BackofficeKernel.invoke()`.
 *
 * These are Backoffice authorization roles, not persisted actor roles or Auth organization role
 * names. System administrators receive the complete permission catalog automatically and
 * organization members receive every non-administration permission automatically. Each later action
 * migration must explicitly update any other roles that should receive it.
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
    organizationId: string | null;
  }>,
  scope: BackofficeContextScope,
): BackofficeUserAuthorityRole | null => {
  // A system administrator may administer shared scopes, but not another user's private scope.
  if (scope.kind === "user") {
    if (scope.userId !== authority.userId) {
      return null;
    }

    return authority.role === "admin" ? "system-administrator" : "user-owner";
  }

  if (scope.kind === "system") {
    return authority.role === "admin" ? "system-administrator" : null;
  }

  if (authority.organizationId !== scope.orgId) {
    return null;
  }

  return authority.role === "admin" ? "system-administrator" : "organization-member";
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

export function getOrganizationRoleGrants(
  roles: readonly string[],
): readonly BackofficePermissionRequirement[] {
  const grants = roles.flatMap((role) =>
    Object.hasOwn(ORGANIZATION_ROLE_GRANTS, role)
      ? ORGANIZATION_ROLE_GRANTS[role as OrganizationRole]
      : [],
  );
  return [...new Set(grants)];
}
