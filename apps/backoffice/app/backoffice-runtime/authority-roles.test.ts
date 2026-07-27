import { describe, expect, test } from "vitest";

import { BACKOFFICE_AUTHORITY_ROLE_GRANTS } from "./authority-roles";
import { BACKOFFICE_PERMISSION } from "./permissions";

const currentKernelPermissions = [
  BACKOFFICE_PERMISSION.otp.create,
  BACKOFFICE_PERMISSION.telegram.send,
];

describe("Backoffice authority role grants", () => {
  test.each(Object.keys(BACKOFFICE_AUTHORITY_ROLE_GRANTS))(
    "%s receives only explicitly adopted kernel permissions",
    (role) => {
      expect(
        BACKOFFICE_AUTHORITY_ROLE_GRANTS[role as keyof typeof BACKOFFICE_AUTHORITY_ROLE_GRANTS],
      ).toEqual(currentKernelPermissions);
    },
  );

  test("does not grant catalog permissions merely because they exist", () => {
    for (const grants of Object.values(BACKOFFICE_AUTHORITY_ROLE_GRANTS)) {
      expect(grants).not.toContain(BACKOFFICE_PERMISSION.store.modify);
      expect(grants).not.toContain(BACKOFFICE_PERMISSION.telegram.read);
    }
  });
});
