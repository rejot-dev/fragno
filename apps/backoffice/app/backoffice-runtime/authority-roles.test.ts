import { assert, describe, expect, test } from "vitest";

import {
  BACKOFFICE_AUTHORITY_ROLE_GRANTS,
  resolveBackofficeInternalServiceAuthorityRole,
  resolveBackofficeUserAuthorityRole,
} from "./authority-roles";
import { BACKOFFICE_PERMISSION } from "./permissions";

const currentKernelPermissions = [
  BACKOFFICE_PERMISSION.otp.create,
  BACKOFFICE_PERMISSION.store.modify,
  BACKOFFICE_PERMISSION.telegram.send,
];

const automationRuntimePermissions = [
  BACKOFFICE_PERMISSION.connections.manage,
  BACKOFFICE_PERMISSION.identity.resolve,
  BACKOFFICE_PERMISSION.internal.manage,
  BACKOFFICE_PERMISSION.otp.create,
  BACKOFFICE_PERMISSION.pi.modify,
  BACKOFFICE_PERMISSION.pi.read,
  BACKOFFICE_PERMISSION.store.modify,
  BACKOFFICE_PERMISSION.store.read,
  BACKOFFICE_PERMISSION.telegram.send,
];

const automationAuthoringPermissions = [
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
  BACKOFFICE_PERMISSION.workflow.modify,
  BACKOFFICE_PERMISSION.workflow.read,
];

describe("Backoffice authority role grants", () => {
  test("grants identity administration only to system administrators and trusted objects", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["system-administrator"]).toEqual([
      BACKOFFICE_PERMISSION.capabilities.read,
      BACKOFFICE_PERMISSION.cloudflare.browserRun,
      BACKOFFICE_PERMISSION.connections.manage,
      BACKOFFICE_PERMISSION.connections.read,
      BACKOFFICE_PERMISSION.events.emit,
      BACKOFFICE_PERMISSION.events.manage,
      BACKOFFICE_PERMISSION.events.read,
      BACKOFFICE_PERMISSION.hooks.read,
      BACKOFFICE_PERMISSION.identity.bind,
      BACKOFFICE_PERMISSION.identity.resolve,
      BACKOFFICE_PERMISSION.identity.revoke,
      BACKOFFICE_PERMISSION.internal.manage,
      BACKOFFICE_PERMISSION.internal.read,
      BACKOFFICE_PERMISSION.otp.create,
      BACKOFFICE_PERMISSION.pi.modify,
      BACKOFFICE_PERMISSION.pi.read,
      BACKOFFICE_PERMISSION.router.modify,
      BACKOFFICE_PERMISSION.router.read,
      BACKOFFICE_PERMISSION.store.modify,
      BACKOFFICE_PERMISSION.store.read,
      BACKOFFICE_PERMISSION.telegram.send,
      BACKOFFICE_PERMISSION.workflow.modify,
      BACKOFFICE_PERMISSION.workflow.read,
    ]);
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS.object).toEqual([
      BACKOFFICE_PERMISSION.identity.bind,
      BACKOFFICE_PERMISSION.identity.resolve,
      BACKOFFICE_PERMISSION.identity.revoke,
      ...currentKernelPermissions,
    ]);
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS.system).toEqual([
      BACKOFFICE_PERMISSION.identity.bind,
      BACKOFFICE_PERMISSION.identity.resolve,
      BACKOFFICE_PERMISSION.identity.revoke,
      ...currentKernelPermissions,
    ]);
  });

  test("grants Cloudflare Browser Run only to system administrators", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["system-administrator"]).toContain(
      BACKOFFICE_PERMISSION.cloudflare.browserRun,
    );
    for (const [role, grants] of Object.entries(BACKOFFICE_AUTHORITY_ROLE_GRANTS)) {
      if (role !== "system-administrator") {
        expect(grants).not.toContain(BACKOFFICE_PERMISSION.cloudflare.browserRun);
      }
    }
  });

  test("allows automations to resolve identity bindings inside workflow logic", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS.automation).toEqual(automationRuntimePermissions);
  });

  test("user owners can use user-scoped automation authoring tools", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["user-owner"]).toEqual(automationAuthoringPermissions);
  });

  test("organization members can use organization-scoped automation authoring tools", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["organization-member"]).toEqual([
      BACKOFFICE_PERMISSION.capabilities.read,
      BACKOFFICE_PERMISSION.connections.manage,
      BACKOFFICE_PERMISSION.connections.read,
      ...automationAuthoringPermissions.slice(1),
    ]);
  });

  test.each(["agent", "capability"] as const)(
    "%s receives the currently adopted workflow permissions",
    (role) => {
      expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS[role]).toEqual(currentKernelPermissions);
    },
  );

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

  test("does not grant unrelated read permissions merely because they exist", () => {
    for (const grants of Object.values(BACKOFFICE_AUTHORITY_ROLE_GRANTS)) {
      expect(grants).not.toContain(BACKOFFICE_PERMISSION.telegram.read);
    }
  });

  test.each([
    [
      { userId: "admin-1", role: "admin" as const, organizationIds: [] },
      { kind: "system" as const },
      "system-administrator",
    ],
    [
      { userId: "admin-1", role: "admin" as const, organizationIds: [] },
      { kind: "org" as const, orgId: "org-1" },
      "system-administrator",
    ],
    [
      { userId: "admin-1", role: "admin" as const, organizationIds: [] },
      { kind: "user" as const, userId: "admin-1" },
      "system-administrator",
    ],
    [
      { userId: "admin-1", role: "admin" as const, organizationIds: [] },
      { kind: "user" as const, userId: "user-1" },
      null,
    ],
    [
      { userId: "user-1", role: "user" as const, organizationIds: [] },
      { kind: "system" as const },
      null,
    ],
    [
      { userId: "user-1", role: "user" as const, organizationIds: [] },
      { kind: "user" as const, userId: "user-1" },
      "user-owner",
    ],
    [
      { userId: "user-1", role: "user" as const, organizationIds: [] },
      { kind: "user" as const, userId: "user-2" },
      null,
    ],
    [
      { userId: "user-1", role: "user" as const, organizationIds: ["org-1"] },
      { kind: "org" as const, orgId: "org-1" },
      "organization-member",
    ],
    [
      { userId: "user-1", role: "user" as const, organizationIds: ["org-1"] },
      { kind: "project" as const, orgId: "org-1", projectId: "project-1" },
      "organization-member",
    ],
    [
      { userId: "user-1", role: "user" as const, organizationIds: [] },
      { kind: "org" as const, orgId: "org-1" },
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
