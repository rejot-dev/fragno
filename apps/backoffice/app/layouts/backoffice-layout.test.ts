import { describe, expect, test } from "vitest";

import { resolveCurrentBackofficeScope } from "./backoffice-layout-scope";

const defaultOrganization = { id: "org-default", slug: "default-org" };
const routeOrganization = { id: "org-route", slug: "route-org" };
const defaultScope = { kind: "org" as const, organization: defaultOrganization };
const organizations = [routeOrganization];

describe("resolveCurrentBackofficeScope", () => {
  test.each([
    [
      { scopeKind: "org", scopeId: "route-org" },
      { kind: "org", organization: routeOrganization },
    ],
    [
      { scopeKind: "user", scopeId: "user-route" },
      { kind: "user", userId: "user-route" },
    ],
    [
      { scopeKind: "project", scopeId: "route-org:project-route" },
      { kind: "project", organization: routeOrganization, projectId: "project-route" },
    ],
    [{ scopeKind: "system", scopeId: "system" }, { kind: "system" }],
  ])("uses an explicit route scope for %s", (params, expectedScope) => {
    expect(resolveCurrentBackofficeScope({ params, defaultScope, organizations })).toEqual(
      expectedScope,
    );
  });

  test("resolves the organization slug selected by an organization route", () => {
    expect(
      resolveCurrentBackofficeScope({
        params: { orgSlug: "route-org" },
        defaultScope,
        organizations,
      }),
    ).toEqual({ kind: "org", organization: routeOrganization });
  });

  test("uses the authenticated default outside an explicitly scoped route", () => {
    expect(resolveCurrentBackofficeScope({ params: {}, defaultScope, organizations })).toEqual(
      defaultScope,
    );
  });
});
