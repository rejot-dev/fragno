import { describe, expect, test, assert } from "vitest";

import { allBackofficePermissionRequirements, BACKOFFICE_PERMISSION } from "./permissions";

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
});
