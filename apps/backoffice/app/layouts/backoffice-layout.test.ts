import { describe, expect, test } from "vitest";

import { resolveBackofficePageScope } from "./backoffice-layout-scope";

const organization = { id: "org-route", slug: "route-org", jurisdiction: null };
const project = { id: "project-1", slug: "website" };
const lookups = {
  organizations: [organization],
  // Page URLs name users by ID alone; resolving one finds where their objects are kept.
  findUser: async (userId: string) => ({ userId, jurisdiction: "eu" as const }),
  isAppInstalled: async () => true,
  findProject: async (_owner: unknown, slug: string) => (slug === project.slug ? project : null),
};

describe("resolveBackofficePageScope", () => {
  test.each([
    [
      { scopeKind: "org", scopeId: "route-org" },
      { kind: "org", organization },
    ],
    [
      { scopeKind: "user", scopeId: "user-route" },
      { kind: "user", userId: "user-route", jurisdiction: "eu" },
    ],
    [
      { scopeKind: "project", scopeId: "org:route-org:website" },
      { kind: "project", owner: { kind: "org", organization }, project },
    ],
    [{ scopeKind: "system", scopeId: "system" }, { kind: "system" }],
    // Organization pages name their organization outside the scoped route parameters.
    [{ orgSlug: "route-org" }, { kind: "org", organization }],
  ])("resolves the scope a URL names for %o", async (params, scope) => {
    await expect(resolveBackofficePageScope({ params, ...lookups })).resolves.toEqual({
      status: "resolved",
      scope,
    });
  });

  test("reports pages without a scope", async () => {
    await expect(resolveBackofficePageScope({ params: {}, ...lookups })).resolves.toEqual({
      status: "absent",
    });
  });
});
