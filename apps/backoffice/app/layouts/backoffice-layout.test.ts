import { describe, expect, test } from "vitest";

import { resolveBackofficePageScope } from "./backoffice-layout-scope";

const organization = { id: "org-route", slug: "route-org" };
const project = { id: "project-1", slug: "website" };
const lookups = {
  organizations: [organization],
  findProject: async (_organization: typeof organization, slug: string) =>
    slug === project.slug ? project : null,
};

describe("resolveBackofficePageScope", () => {
  test.each([
    [
      { scopeKind: "org", scopeId: "route-org" },
      { kind: "org", organization },
    ],
    [
      { scopeKind: "user", scopeId: "user-route" },
      { kind: "user", userId: "user-route" },
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
