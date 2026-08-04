import type { Role } from "@fragno-dev/auth";

import type { AutomationEntityRef } from "@/fragno/automation/actors";

import type { BackofficeContextScope } from "./context";
import {
  allBackofficePermissionRequirements,
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "./permissions";

const USER_AUTHORITY_ROLE_GRANTS = {
  "system-administrator": allBackofficePermissionRequirements,
  "user-owner": [
    BACKOFFICE_PERMISSION.capabilities.read,
    BACKOFFICE_PERMISSION.events.emit,
    BACKOFFICE_PERMISSION.events.manage,
    BACKOFFICE_PERMISSION.events.read,
    BACKOFFICE_PERMISSION.hooks.read,
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
    BACKOFFICE_PERMISSION.workflow.modify,
    BACKOFFICE_PERMISSION.workflow.read,
  ],
  "organization-member": [
    BACKOFFICE_PERMISSION.capabilities.read,
    BACKOFFICE_PERMISSION.connections.manage,
    BACKOFFICE_PERMISSION.connections.read,
    BACKOFFICE_PERMISSION.events.emit,
    BACKOFFICE_PERMISSION.events.manage,
    BACKOFFICE_PERMISSION.events.read,
    BACKOFFICE_PERMISSION.hooks.read,
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
    BACKOFFICE_PERMISSION.workflow.modify,
    BACKOFFICE_PERMISSION.workflow.read,
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
    BACKOFFICE_PERMISSION.connections.manage,
    BACKOFFICE_PERMISSION.identity.resolve,
    BACKOFFICE_PERMISSION.internal.manage,
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.pi.modify,
    BACKOFFICE_PERMISSION.pi.read,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.store.read,
    BACKOFFICE_PERMISSION.telegram.send,
    BACKOFFICE_PERMISSION.upload.modify,
    BACKOFFICE_PERMISSION.upload.read,
  ],
  agent: [
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
    BACKOFFICE_PERMISSION.upload.modify,
    BACKOFFICE_PERMISSION.upload.read,
  ],
  capability: [
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
    BACKOFFICE_PERMISSION.telegram.send,
    BACKOFFICE_PERMISSION.upload.modify,
    BACKOFFICE_PERMISSION.upload.read,
  ],
  object: [
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
 * names. System administrators receive the complete permission catalog automatically. Each later
 * action migration must explicitly update any non-administrator roles that should receive it.
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
  // A system administrator may administer shared scopes, but not another user's private scope.
  if (scope.kind === "user") {
    if (scope.userId !== authority.userId) {
      return null;
    }

    return authority.role === "admin" ? "system-administrator" : "user-owner";
  }

  if (authority.role === "admin") {
    return "system-administrator";
  }

  if (scope.kind === "system") {
    return null;
  }

  return authority.organizationIds.includes(scope.orgId) ? "organization-member" : null;
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
