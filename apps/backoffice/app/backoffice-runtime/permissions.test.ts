import { describe, expect, test, assert } from "vitest";

import {
  allBackofficePermissionRequirements,
  BACKOFFICE_PERMISSION,
  isBackofficePermissionRequirement,
} from "./permissions";

describe("Backoffice permissions", () => {
  test("enumerates every permission as one unique concrete requirement", () => {
    const expectedCount = Object.values(BACKOFFICE_PERMISSION).reduce(
      (count, permissions) => count + Object.keys(permissions).length,
      0,
    );
    const permissionKeys = allBackofficePermissionRequirements.map(
      ({ namespace, permission }) => `${namespace}.${permission}`,
    );

    expect(permissionKeys).toHaveLength(expectedCount);
    expect(new Set(permissionKeys)).toHaveLength(expectedCount);
    assert(permissionKeys.every((key) => !key.includes("*")));
  });

  test("rejects wildcards, unknown values, and mismatched namespace-permission pairs", () => {
    assert(!isBackofficePermissionRequirement({ namespace: "*", permission: "*" }));
    assert(!isBackofficePermissionRequirement({ namespace: "telegram", permission: "unknown" }));
    assert(!isBackofficePermissionRequirement({ namespace: "telegram", permission: "create" }));
    assert(isBackofficePermissionRequirement({ namespace: "identity", permission: "bind" }));
    assert(isBackofficePermissionRequirement({ namespace: "identity", permission: "resolve" }));
    assert(isBackofficePermissionRequirement({ namespace: "identity", permission: "revoke" }));
    assert(isBackofficePermissionRequirement({ namespace: "telegram", permission: "send" }));
  });
});
