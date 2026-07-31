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

describe("Backoffice authority role grants", () => {
  test("keeps system administration limited to store mutation", () => {
    expect(BACKOFFICE_AUTHORITY_ROLE_GRANTS["system-administrator"]).toEqual([
      BACKOFFICE_PERMISSION.store.modify,
    ]);
  });

  test.each(
    Object.keys(BACKOFFICE_AUTHORITY_ROLE_GRANTS).filter((role) => role !== "system-administrator"),
  )("%s receives the currently adopted kernel permissions", (role) => {
    expect(
      BACKOFFICE_AUTHORITY_ROLE_GRANTS[role as keyof typeof BACKOFFICE_AUTHORITY_ROLE_GRANTS],
    ).toEqual(currentKernelPermissions);
  });

  test("does not grant catalog permissions merely because they exist", () => {
    for (const grants of Object.values(BACKOFFICE_AUTHORITY_ROLE_GRANTS)) {
      expect(grants).not.toContain(BACKOFFICE_PERMISSION.store.read);
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
