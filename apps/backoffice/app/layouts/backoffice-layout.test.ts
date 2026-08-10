import { describe, expect, test } from "vitest";

import { resolveCurrentBackofficeScope } from "./backoffice-layout-scope";

const defaultScope = { kind: "org" as const, orgId: "org-default" };

describe("resolveCurrentBackofficeScope", () => {
  test.each([
    [
      { scopeKind: "org", scopeId: "org-route" },
      { kind: "org", orgId: "org-route" },
    ],
    [
      { scopeKind: "user", scopeId: "user-route" },
      { kind: "user", userId: "user-route" },
    ],
    [
      { scopeKind: "project", scopeId: "org-route:project-route" },
      { kind: "project", orgId: "org-route", projectId: "project-route" },
    ],
    [{ scopeKind: "system", scopeId: "system" }, { kind: "system" }],
  ])("uses an explicit route scope for %s", (params, expectedScope) => {
    expect(resolveCurrentBackofficeScope({ params, defaultScope })).toEqual(expectedScope);
  });

  test("uses the organization selected by an organization route", () => {
    expect(
      resolveCurrentBackofficeScope({
        params: { orgId: "org-route" },
        defaultScope,
      }),
    ).toEqual({ kind: "org", orgId: "org-route" });
  });

  test("uses the authenticated default outside an explicitly scoped route", () => {
    expect(resolveCurrentBackofficeScope({ params: {}, defaultScope })).toEqual(defaultScope);
  });
});
