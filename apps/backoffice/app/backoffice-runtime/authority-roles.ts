import type { OrganizationRole, Role } from "@/fragno/auth/contracts";
import type { AutomationEntityRef } from "@/fragno/automation/actors";

import type { BackofficeContextScope } from "./context";
import {
  allBackofficePermissionRequirements,
  BACKOFFICE_PERMISSION,
  type BackofficePermissionNamespace,
  type BackofficePermissionRequirement,
} from "./permissions";

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

type BackofficePermissionDecision = "grant" | "deny";

/** One explicit decision for every permission in the catalog, so new permissions fail to compile. */
type BackofficePermissionDecisions = {
  readonly [TNamespace in BackofficePermissionNamespace]: {
    readonly [TKey in keyof (typeof BACKOFFICE_PERMISSION)[TNamespace]]: BackofficePermissionDecision;
  };
};

/**
 * Roles for human users, chosen per scope by `resolveBackofficeUserAuthorityRole`.
 *
 * `user-owner` and `organization-member` are the same non-admin user in different scopes:
 * `user-owner` applies in the user's own personal scope, while `organization-member` applies in an
 * organization or project scope of the user's organization. Both receive almost every
 * non-administration permission; organization members additionally link and resolve external
 * identities, route events, and receive live organization-role permissions. Admins resolve to
 * `system-administrator` in either scope.
 */
export const USER_AUTHORITY_ROLE_PERMISSION_DECISIONS = {
  "system-administrator": {
    account: { read: "grant", manage: "grant" },
    admin: {
      appsManage: "grant",
      appsRead: "grant",
      oauthClientsManage: "grant",
      oauthClientsRead: "grant",
      signUpInvitationsManage: "grant",
      organizationsManage: "grant",
    },
    apps: { read: "grant", manage: "grant" },
    api: {
      connectionsCreate: "grant",
      connectionsDelete: "grant",
      connectionsRead: "grant",
      requestsExecute: "grant",
      webhooksManage: "grant",
      webhooksRead: "grant",
    },
    capabilities: { read: "grant" },
    cloudflare: { browserRun: "grant" },
    connections: { manage: "grant", read: "grant" },
    events: { emit: "grant", manage: "grant", read: "grant", route: "grant" },
    forms: { create: "grant", read: "grant", update: "grant" },
    hooks: { read: "grant" },
    identity: { link: "grant", bind: "grant", read: "grant", resolve: "grant", revoke: "grant" },
    integrations: { read: "grant", manage: "grant", execute: "grant" },
    internal: { manage: "grant" },
    org: { read: "grant", manage: "grant" },
    marketplace: { read: "grant", publish: "grant" },
    packages: { read: "grant", install: "grant" },
    mcp: {
      serversCreate: "grant",
      serversDelete: "grant",
      serversRead: "grant",
      toolsCall: "grant",
    },
    connector: {
      providersRead: "grant",
      accountsRead: "grant",
      connectionsCreate: "grant",
      actionsExecute: "grant",
    },
    otp: { create: "grant" },
    pi: { modify: "grant", read: "grant" },
    resend: { read: "grant", send: "grant" },
    reson8: { use: "grant" },
    router: { modify: "grant", read: "grant" },
    sandbox: { modify: "grant", read: "grant" },
    store: { modify: "grant", read: "grant" },
    telegram: { read: "grant", send: "grant" },
    upload: { modify: "grant", read: "grant" },
    workflow: { executeCode: "grant", modify: "grant", read: "grant" },
  },
  "user-owner": {
    account: { read: "grant", manage: "grant" },
    admin: {
      appsManage: "deny",
      appsRead: "deny",
      oauthClientsManage: "deny",
      oauthClientsRead: "deny",
      signUpInvitationsManage: "deny",
      organizationsManage: "deny",
    },
    apps: { read: "deny", manage: "deny" },
    api: {
      connectionsCreate: "grant",
      connectionsDelete: "grant",
      connectionsRead: "grant",
      requestsExecute: "grant",
      webhooksManage: "grant",
      webhooksRead: "grant",
    },
    capabilities: { read: "grant" },
    cloudflare: { browserRun: "grant" },
    connections: { manage: "grant", read: "grant" },
    events: { emit: "grant", manage: "grant", read: "grant", route: "deny" },
    forms: { create: "grant", read: "grant", update: "grant" },
    hooks: { read: "grant" },
    identity: { link: "deny", bind: "deny", read: "grant", resolve: "deny", revoke: "deny" },
    integrations: { read: "grant", manage: "grant", execute: "grant" },
    internal: { manage: "deny" },
    org: { read: "deny", manage: "deny" },
    marketplace: { read: "grant", publish: "grant" },
    packages: { read: "grant", install: "grant" },
    mcp: {
      serversCreate: "grant",
      serversDelete: "grant",
      serversRead: "grant",
      toolsCall: "grant",
    },
    connector: {
      providersRead: "grant",
      accountsRead: "grant",
      connectionsCreate: "grant",
      actionsExecute: "grant",
    },
    otp: { create: "grant" },
    pi: { modify: "grant", read: "grant" },
    resend: { read: "grant", send: "grant" },
    reson8: { use: "grant" },
    router: { modify: "grant", read: "grant" },
    sandbox: { modify: "grant", read: "grant" },
    store: { modify: "grant", read: "grant" },
    telegram: { read: "grant", send: "grant" },
    upload: { modify: "grant", read: "grant" },
    workflow: { executeCode: "grant", modify: "grant", read: "grant" },
  },
  "organization-member": {
    account: { read: "grant", manage: "grant" },
    // Administration stays with system administrators.
    admin: {
      appsManage: "deny",
      appsRead: "deny",
      oauthClientsManage: "deny",
      oauthClientsRead: "deny",
      signUpInvitationsManage: "deny",
      organizationsManage: "deny",
    },
    // Resolved from live organization roles, never from the Backoffice user role.
    apps: { read: "deny", manage: "deny" },
    api: {
      connectionsCreate: "grant",
      connectionsDelete: "grant",
      connectionsRead: "grant",
      requestsExecute: "grant",
      webhooksManage: "grant",
      webhooksRead: "grant",
    },
    capabilities: { read: "grant" },
    cloudflare: { browserRun: "grant" },
    connections: { manage: "grant", read: "grant" },
    events: { emit: "grant", manage: "grant", read: "grant", route: "grant" },
    forms: { create: "grant", read: "grant", update: "grant" },
    hooks: { read: "grant" },
    // Binding or revoking an external identity for an arbitrary user lets the caller act as them.
    identity: { link: "grant", bind: "deny", read: "grant", resolve: "grant", revoke: "deny" },
    integrations: { read: "grant", manage: "grant", execute: "grant" },
    // Internal maintenance stays with system administrators.
    internal: { manage: "deny" },
    // Resolved from live organization roles, never from the Backoffice user role.
    org: { read: "deny", manage: "deny" },
    marketplace: { read: "grant", publish: "grant" },
    packages: { read: "grant", install: "grant" },
    mcp: {
      serversCreate: "grant",
      serversDelete: "grant",
      serversRead: "grant",
      toolsCall: "grant",
    },
    connector: {
      providersRead: "grant",
      accountsRead: "grant",
      connectionsCreate: "grant",
      actionsExecute: "grant",
    },
    otp: { create: "grant" },
    pi: { modify: "grant", read: "grant" },
    resend: { read: "grant", send: "grant" },
    reson8: { use: "grant" },
    router: { modify: "grant", read: "grant" },
    sandbox: { modify: "grant", read: "grant" },
    store: { modify: "grant", read: "grant" },
    telegram: { read: "grant", send: "grant" },
    upload: { modify: "grant", read: "grant" },
    workflow: { executeCode: "grant", modify: "grant", read: "grant" },
  },
} as const satisfies Record<string, BackofficePermissionDecisions>;

function grantedPermissionRequirements(
  decisions: BackofficePermissionDecisions,
): readonly BackofficePermissionRequirement[] {
  const catalog: Readonly<
    Record<string, Readonly<Record<string, BackofficePermissionRequirement>>>
  > = BACKOFFICE_PERMISSION;
  const decided: Readonly<Record<string, Readonly<Record<string, BackofficePermissionDecision>>>> =
    decisions;
  return Object.entries(catalog).flatMap(([namespace, requirements]) =>
    Object.entries(requirements).flatMap(([key, requirement]) =>
      decided[namespace][key] === "grant" ? [requirement] : [],
    ),
  );
}

const USER_AUTHORITY_ROLE_GRANTS = {
  "system-administrator": grantedPermissionRequirements(
    USER_AUTHORITY_ROLE_PERMISSION_DECISIONS["system-administrator"],
  ),
  "user-owner": grantedPermissionRequirements(
    USER_AUTHORITY_ROLE_PERMISSION_DECISIONS["user-owner"],
  ),
  "organization-member": grantedPermissionRequirements(
    USER_AUTHORITY_ROLE_PERMISSION_DECISIONS["organization-member"],
  ),
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
 * names. User roles decide every catalog permission explicitly, so adding a permission does not
 * compile until each user role grants or denies it. Each later action migration must explicitly
 * update any internal service roles that should receive it.
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
