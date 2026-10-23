import type { AutomationEntityRef } from "@fragno-dev/backoffice-api/v0/automation";
import type { OrganizationRole } from "@fragno-dev/backoffice-api/v0/organization";
import {
  allBackofficePermissionRequirements,
  BACKOFFICE_PERMISSION,
  type BackofficePermissionNamespace,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  type BackofficeScope,
  type BackofficeScopeNames,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { Role } from "@/fragno/auth/contracts";

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

/**
 * What a person administers in their own user scope, where no membership exists to consult: the
 * apps they installed for themselves.
 */
export const PERSONAL_SCOPE_GRANTS = [
  BACKOFFICE_PERMISSION.apps.read,
  BACKOFFICE_PERMISSION.apps.manage,
] as const satisfies readonly BackofficePermissionRequirement[];

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
 * What a person may do in a personal workspace they act in: their own, or a member's whose
 * organization they administer.
 */
const PERSONAL_WORKSPACE_PERMISSION_DECISIONS = {
  projects: { create: "grant", read: "grant" },
  account: { read: "grant", manage: "grant" },
  admin: {
    appsManage: "deny",
    appsRead: "deny",
    oauthClientsManage: "deny",
    oauthClientsRead: "deny",
    signUpInvitationsManage: "deny",
    organizationsManage: "deny",
    usersManage: "deny",
  },
  apps: { read: "deny", manage: "deny" },
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
  // Curating the public Marketplace stays with system administrators.
  marketplace: { read: "grant", publish: "grant", feature: "deny" },
  models: { classify: "grant", generateImage: "grant" },
  packages: { read: "grant", install: "grant" },
  otp: { create: "grant" },
  pi: { manage: "grant", modify: "grant", read: "grant" },
  reson8: { transcribe: "grant" },
  router: { modify: "grant", read: "grant" },
  sandbox: { modify: "grant", read: "grant" },
  store: { modify: "grant", read: "grant" },
  upload: { modify: "grant", read: "grant" },
  workflow: { executeCode: "grant", modify: "grant", read: "grant" },
} as const satisfies BackofficePermissionDecisions;

/**
 * Roles for human users, chosen per scope by `resolveBackofficeUserAuthorityRole`.
 *
 * `user-owner` and `organization-member` are the same non-admin user in different scopes:
 * `user-owner` applies in the user's own personal scope, while `organization-member` applies in an
 * organization or project scope of the user's organization. Both receive almost every
 * non-administration permission; organization members additionally link and resolve external
 * identities, route events, and receive live organization-role permissions. Admins resolve to
 * `system-administrator` in either scope.
 *
 * `member-administrator` is an owner or admin of an organization, in the personal scope of one of
 * its members. They act there as the member would, so members share their personal workspace with
 * the people who administer their organizations.
 *
 * `app-workspace-observer` is anyone with a role in the scope that installed an app, inside that
 * app's workspace: the app keeps its data there, so people may read but not change it.
 */
export const USER_AUTHORITY_ROLE_PERMISSION_DECISIONS = {
  "system-administrator": {
    projects: { create: "grant", read: "grant" },
    account: { read: "grant", manage: "grant" },
    admin: {
      appsManage: "grant",
      appsRead: "grant",
      oauthClientsManage: "grant",
      oauthClientsRead: "grant",
      signUpInvitationsManage: "grant",
      organizationsManage: "grant",
      usersManage: "grant",
    },
    apps: { read: "grant", manage: "grant" },
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
    marketplace: { read: "grant", publish: "grant", feature: "grant" },
    models: { classify: "grant", generateImage: "grant" },
    packages: { read: "grant", install: "grant" },
    otp: { create: "grant" },
    pi: { manage: "grant", modify: "grant", read: "grant" },
    reson8: { transcribe: "grant" },
    router: { modify: "grant", read: "grant" },
    sandbox: { modify: "grant", read: "grant" },
    store: { modify: "grant", read: "grant" },
    upload: { modify: "grant", read: "grant" },
    workflow: { executeCode: "grant", modify: "grant", read: "grant" },
  },
  "user-owner": PERSONAL_WORKSPACE_PERMISSION_DECISIONS,
  // Administering an organization reaches its members' personal workspaces as their owners would.
  "member-administrator": PERSONAL_WORKSPACE_PERMISSION_DECISIONS,
  "organization-member": {
    projects: { create: "grant", read: "grant" },
    account: { read: "grant", manage: "grant" },
    // Administration stays with system administrators.
    admin: {
      appsManage: "deny",
      appsRead: "deny",
      oauthClientsManage: "deny",
      oauthClientsRead: "deny",
      signUpInvitationsManage: "deny",
      organizationsManage: "deny",
      usersManage: "deny",
    },
    // Resolved from live organization roles, never from the Backoffice user role.
    apps: { read: "deny", manage: "deny" },
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
    // Organization Marketplaces are curated through org.manage from live membership.
    marketplace: { read: "grant", publish: "grant", feature: "deny" },
    models: { classify: "grant", generateImage: "grant" },
    packages: { read: "grant", install: "grant" },
    otp: { create: "grant" },
    pi: { manage: "grant", modify: "grant", read: "grant" },
    reson8: { transcribe: "grant" },
    router: { modify: "grant", read: "grant" },
    sandbox: { modify: "grant", read: "grant" },
    store: { modify: "grant", read: "grant" },
    upload: { modify: "grant", read: "grant" },
    workflow: { executeCode: "grant", modify: "grant", read: "grant" },
  },
  "app-workspace-observer": {
    projects: { create: "deny", read: "deny" },
    // A person's own account is not the workspace's.
    account: { read: "grant", manage: "grant" },
    admin: {
      appsManage: "deny",
      appsRead: "deny",
      oauthClientsManage: "deny",
      oauthClientsRead: "deny",
      signUpInvitationsManage: "deny",
      organizationsManage: "deny",
      usersManage: "deny",
    },
    apps: { read: "deny", manage: "deny" },
    capabilities: { read: "grant" },
    cloudflare: { browserRun: "deny" },
    // Integrations are not available in a workspace, so there is nothing of them to read.
    connections: { manage: "deny", read: "deny" },
    events: { emit: "deny", manage: "deny", read: "grant", route: "deny" },
    forms: { create: "deny", read: "grant", update: "deny" },
    hooks: { read: "grant" },
    identity: { link: "deny", bind: "deny", read: "grant", resolve: "deny", revoke: "deny" },
    integrations: { read: "deny", manage: "deny", execute: "deny" },
    internal: { manage: "deny" },
    org: { read: "deny", manage: "deny" },
    marketplace: { read: "grant", publish: "deny", feature: "deny" },
    // Every model call is billed to the workspace's organization.
    models: { classify: "deny", generateImage: "deny" },
    packages: { read: "grant", install: "deny" },
    otp: { create: "deny" },
    pi: { manage: "deny", modify: "deny", read: "grant" },
    reson8: { transcribe: "deny" },
    router: { modify: "deny", read: "grant" },
    sandbox: { modify: "deny", read: "grant" },
    store: { modify: "deny", read: "grant" },
    upload: { modify: "deny", read: "grant" },
    workflow: { executeCode: "deny", modify: "deny", read: "grant" },
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
  "member-administrator": grantedPermissionRequirements(
    USER_AUTHORITY_ROLE_PERMISSION_DECISIONS["member-administrator"],
  ),
  "organization-member": grantedPermissionRequirements(
    USER_AUTHORITY_ROLE_PERMISSION_DECISIONS["organization-member"],
  ),
  "app-workspace-observer": grantedPermissionRequirements(
    USER_AUTHORITY_ROLE_PERMISSION_DECISIONS["app-workspace-observer"],
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
    BACKOFFICE_PERMISSION.upload.modify,
    BACKOFFICE_PERMISSION.upload.read,
  ],
  // Runtime capability grants remain the narrower per-execution boundary.
  capability: allBackofficePermissionRequirements,
  // A Pi agent's definition narrows its turns at runtime. Work its turns persist, such as scheduled
  // workflows, runs without that narrowing, bounded by the principal like any other delegation.
  "pi-agent": allBackofficePermissionRequirements,
  object: [
    BACKOFFICE_PERMISSION.marketplace.publish,
    BACKOFFICE_PERMISSION.identity.bind,
    BACKOFFICE_PERMISSION.identity.resolve,
    BACKOFFICE_PERMISSION.identity.revoke,
    BACKOFFICE_PERMISSION.otp.create,
    BACKOFFICE_PERMISSION.store.modify,
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

/** The verified or current facts that decide a user's role in a scope. */
export type BackofficeUserAuthority = Readonly<{
  userId: string;
  role: Role;
  organizationId: string | null;
  /**
   * A member of an organization this user owns or administers, whose personal workspace they may
   * act in: verified once per request at its execution boundary, or read live for deferred work.
   */
  administeredMemberId: string | null;
}>;

/** The user who owns the scope, when that is someone other than `userId`. */
export function backofficeScopeOtherUserId(
  userId: string,
  scope: BackofficeScope<BackofficeScopeNames>,
): string | null {
  const owner = backofficeScopeRootOwner(scope);
  return owner?.kind === "user" && owner.userId !== userId ? owner.userId : null;
}

/**
 * Maps verified or current user facts to the one Backoffice role available in a scope. A project
 * answers to its owner, so a person's role in a project is their role in the owning scope.
 */
export const resolveBackofficeUserAuthorityRole = (
  authority: BackofficeUserAuthority,
  scope: BackofficeContextScope,
): BackofficeUserAuthorityRole | null => {
  switch (scope.kind) {
    case "system":
      return authority.role === "admin" ? "system-administrator" : null;
    // System administration does not reach another user's private scope; administering an
    // organization the user belongs to does.
    case "user":
      if (scope.userId === authority.userId) {
        return authority.role === "admin" ? "system-administrator" : "user-owner";
      }
      return scope.userId === authority.administeredMemberId ? "member-administrator" : null;
    case "org":
      if (authority.organizationId !== scope.orgId) {
        return null;
      }
      return authority.role === "admin" ? "system-administrator" : "organization-member";
    case "project":
      return resolveBackofficeUserAuthorityRole(authority, scope.owner);
    case "app":
      return resolveBackofficeUserAuthorityRole(authority, scope.owner) === null
        ? null
        : "app-workspace-observer";
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
  }
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
