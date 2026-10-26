import { assert, describe, expect, test } from "vitest";

import {
  allBackofficePermissionRequirements,
  BACKOFFICE_PERMISSION,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";

import {
  BACKOFFICE_AUTHORITY_ROLE_GRANTS,
  resolveBackofficeInternalServiceAuthorityRole,
  resolveBackofficeUserAuthorityRole,
  USER_AUTHORITY_ROLE_PERMISSION_DECISIONS,
} from "./authority-roles";

const currentKernelPermissions = [
  BACKOFFICE_PERMISSION.otp.create,
  BACKOFFICE_PERMISSION.store.modify,
  BACKOFFICE_PERMISSION.upload.modify,
  BACKOFFICE_PERMISSION.upload.read,
];

describe("Backoffice authority role grants", () => {
  test("user roles grant or deny every catalog permission", () => {
    const catalog = Object.fromEntries(
      Object.entries(BACKOFFICE_PERMISSION).map(([namespace, requirements]) => [
        namespace,
        Object.keys(requirements),
      ]),
    );
    for (const decisions of Object.values(USER_AUTHORITY_ROLE_PERMISSION_DECISIONS)) {
      const decided = Object.fromEntries(
        Object.entries(decisions).map(([namespace, namespaceDecisions]) => {
          for (const decision of Object.values(namespaceDecisions)) {
            expect(["grant", "deny"]).toContain(decision);
          }
          return [namespace, Object.keys(namespaceDecisions)];
        }),
      );
      expect(decided).toEqual(catalog);
    }
  });

  test("grants every permission to system administrators", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["system-administrator"]).toEqual(
      allBackofficePermissionRequirements,
    );
  });

  test("grants identity administration to trusted objects", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS.object).toEqual([
      BACKOFFICE_PERMISSION.marketplace.publish,
      BACKOFFICE_PERMISSION.identity.bind,
      BACKOFFICE_PERMISSION.identity.resolve,
      BACKOFFICE_PERMISSION.identity.revoke,
      ...currentKernelPermissions,
    ]);
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS.system).toEqual([
      BACKOFFICE_PERMISSION.marketplace.publish,
      BACKOFFICE_PERMISSION.identity.bind,
      BACKOFFICE_PERMISSION.identity.resolve,
      BACKOFFICE_PERMISSION.identity.revoke,
      ...currentKernelPermissions,
    ]);
  });

  test("keeps Cloudflare Browser Run out of constrained authority roles", () => {
    const unrestrictedRoles = new Set([
      "system-administrator",
      "organization-member",
      "user-owner",
      "member-administrator",
      "automation",
      "capability",
      "pi-agent",
    ]);
    for (const [role, grants] of Object.entries(BACKOFFICE_AUTHORITY_ROLE_GRANTS)) {
      if (!unrestrictedRoles.has(role)) {
        expect(grants).not.toContain(BACKOFFICE_PERMISSION.cloudflare.browserRun);
      }
    }
  });

  test("uses the canonical permission set for automation, capability, and Pi agent actors", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS.automation).toEqual(
      allBackofficePermissionRequirements,
    );
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS.capability).toEqual(
      allBackofficePermissionRequirements,
    );
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["pi-agent"]).toEqual(
      allBackofficePermissionRequirements,
    );
  });

  test("allows human automation owners to inspect identity bindings", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["user-owner"]).toContain(
      BACKOFFICE_PERMISSION.identity.read,
    );
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["organization-member"]).toContain(
      BACKOFFICE_PERMISSION.identity.read,
    );
  });

  test("agents receive the currently adopted workflow permissions", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS.agent).toEqual([
      BACKOFFICE_PERMISSION.marketplace.publish,
      ...currentKernelPermissions,
    ]);
  });

  test("keeps organization administration out of constrained authority roles", () => {
    const unrestrictedRoles = new Set([
      "system-administrator",
      "automation",
      "capability",
      "pi-agent",
    ]);
    for (const [role, grants] of Object.entries(BACKOFFICE_AUTHORITY_ROLE_GRANTS)) {
      if (!unrestrictedRoles.has(role)) {
        expect(grants).not.toContain(BACKOFFICE_PERMISSION.admin.organizationsManage);
      }
    }
  });

  test("restricts human internal maintenance access to system administrators", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["system-administrator"]).toContain(
      BACKOFFICE_PERMISSION.internal.manage,
    );
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["user-owner"]).not.toContain(
      BACKOFFICE_PERMISSION.internal.manage,
    );
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["organization-member"]).not.toContain(
      BACKOFFICE_PERMISSION.internal.manage,
    );
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS.automation).toContain(
      BACKOFFICE_PERMISSION.internal.manage,
    );
  });

  test("does not grant unrelated read permissions to constrained authority roles", () => {
    const unrestrictedRoles = new Set([
      "system-administrator",
      "organization-member",
      "user-owner",
      "member-administrator",
      "automation",
      "capability",
      "pi-agent",
    ]);
    for (const [role, grants] of Object.entries(BACKOFFICE_AUTHORITY_ROLE_GRANTS)) {
      if (!unrestrictedRoles.has(role)) {
        expect(grants).not.toContain(BACKOFFICE_PERMISSION.integrations.read);
      }
    }
  });

  test.each([
    [
      {
        userId: "admin-1",
        personalScope: { kind: "user" as const, userId: "admin-1", jurisdiction: null },
        role: "admin" as const,
        organization: null,
        administeredMember: null,
      },
      { kind: "system" as const },
      "system-administrator",
    ],
    [
      {
        userId: "admin-1",
        personalScope: { kind: "user" as const, userId: "admin-1", jurisdiction: null },
        role: "admin" as const,
        organization: null,
        administeredMember: null,
      },
      { kind: "org" as const, orgId: "org-1", jurisdiction: null },
      null,
    ],
    [
      {
        userId: "admin-1",
        personalScope: { kind: "user" as const, userId: "admin-1", jurisdiction: null },
        role: "admin" as const,
        organization: null,
        administeredMember: null,
      },
      { kind: "user" as const, userId: "admin-1", jurisdiction: null },
      "system-administrator",
    ],
    [
      {
        userId: "admin-1",
        personalScope: { kind: "user" as const, userId: "admin-1", jurisdiction: null },
        role: "admin" as const,
        organization: null,
        administeredMember: null,
      },
      { kind: "user" as const, userId: "user-1", jurisdiction: null },
      null,
    ],
    [
      {
        userId: "user-1",
        personalScope: { kind: "user" as const, userId: "user-1", jurisdiction: null },
        role: "user" as const,
        organization: null,
        administeredMember: null,
      },
      { kind: "system" as const },
      null,
    ],
    [
      {
        userId: "user-1",
        personalScope: { kind: "user" as const, userId: "user-1", jurisdiction: null },
        role: "user" as const,
        organization: null,
        administeredMember: null,
      },
      { kind: "user" as const, userId: "user-1", jurisdiction: null },
      "user-owner",
    ],
    [
      {
        userId: "user-1",
        personalScope: { kind: "user" as const, userId: "user-1", jurisdiction: null },
        role: "user" as const,
        organization: null,
        administeredMember: null,
      },
      { kind: "user" as const, userId: "user-2", jurisdiction: null },
      null,
    ],
    [
      {
        userId: "user-1",
        personalScope: { kind: "user" as const, userId: "user-1", jurisdiction: null },
        role: "user" as const,
        organization: null,
        administeredMember: { kind: "user" as const, userId: "user-2", jurisdiction: null },
      },
      {
        kind: "project" as const,
        owner: { kind: "user" as const, userId: "user-2", jurisdiction: null },
        projectId: "project-1",
      },
      "member-administrator",
    ],
    [
      {
        userId: "user-1",
        personalScope: { kind: "user" as const, userId: "user-1", jurisdiction: null },
        role: "user" as const,
        organization: null,
        administeredMember: { kind: "user" as const, userId: "user-2", jurisdiction: null },
      },
      { kind: "user" as const, userId: "user-3", jurisdiction: null },
      null,
    ],
    [
      {
        userId: "admin-1",
        personalScope: { kind: "user" as const, userId: "admin-1", jurisdiction: null },
        role: "admin" as const,
        organization: null,
        administeredMember: { kind: "user" as const, userId: "user-1", jurisdiction: null },
      },
      { kind: "user" as const, userId: "user-1", jurisdiction: null },
      "member-administrator",
    ],
    [
      {
        userId: "user-1",
        personalScope: { kind: "user" as const, userId: "user-1", jurisdiction: null },
        role: "user" as const,
        organization: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
        administeredMember: null,
      },
      { kind: "org" as const, orgId: "org-1", jurisdiction: null },
      "organization-member",
    ],
    [
      {
        userId: "user-1",
        personalScope: { kind: "user" as const, userId: "user-1", jurisdiction: null },
        role: "user" as const,
        organization: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
        administeredMember: null,
      },
      {
        kind: "project" as const,
        owner: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
        projectId: "project-1",
      },
      "organization-member",
    ],
    [
      {
        userId: "user-1",
        personalScope: { kind: "user" as const, userId: "user-1", jurisdiction: null },
        role: "user" as const,
        organization: null,
        administeredMember: null,
      },
      { kind: "org" as const, orgId: "org-1", jurisdiction: null },
      null,
    ],
    // The same organization ID in another jurisdiction names other objects.
    [
      {
        userId: "user-1",
        personalScope: { kind: "user" as const, userId: "user-1", jurisdiction: null },
        role: "user" as const,
        organization: { kind: "org" as const, orgId: "org-1", jurisdiction: "eu" as const },
        administeredMember: null,
      },
      { kind: "org" as const, orgId: "org-1", jurisdiction: null },
      null,
    ],
    [
      {
        userId: "user-1",
        personalScope: { kind: "user" as const, userId: "user-1", jurisdiction: "eu" as const },
        role: "user" as const,
        organization: null,
        administeredMember: null,
      },
      { kind: "user" as const, userId: "user-1", jurisdiction: "eu" as const },
      "user-owner",
    ],
    // Until onboarding fixes its jurisdiction, no scope is the user's own.
    [
      {
        userId: "user-1",
        personalScope: null,
        role: "user" as const,
        organization: null,
        administeredMember: null,
      },
      { kind: "user" as const, userId: "user-1", jurisdiction: null },
      null,
    ],
  ])("maps user authority to its scope role", (authority, scope, expectedRole) => {
    expect(resolveBackofficeUserAuthorityRole(authority, scope)).toBe(expectedRole);
  });

  test("recognizes internal service identities from the authority catalog", () => {
    assert.equal(
      resolveBackofficeInternalServiceAuthorityRole({
        scope: "internal",
        type: "automation",
      }),
      "automation",
    );
    assert.isNull(
      resolveBackofficeInternalServiceAuthorityRole({
        scope: "external",
        type: "automation",
      }),
    );
    assert.isNull(
      resolveBackofficeInternalServiceAuthorityRole({
        scope: "internal",
        type: "user",
      }),
    );
  });
});
