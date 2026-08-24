import { assert, describe, expect, test } from "vitest";

import {
  backofficeResolvedScopeFromRuntimeScope,
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
  resolveBackofficeRuntimeScope,
} from "./resolved-scope";
import { backofficeRouteScopeFromParams, backofficeRouteScopePath } from "./route-scope";

describe("Backoffice route scope", () => {
  const organizations = [{ id: "org_123", slug: "acme" }];

  test("builds slug-backed organization and project paths from resolved identity", () => {
    const organizationScope = backofficeResolvedScopeFromRuntimeScope(
      { kind: "org", orgId: "org_123" },
      organizations[0]!,
    );
    const projectScope = backofficeResolvedScopeFromRuntimeScope(
      { kind: "project", orgId: "org_123", projectId: "project_1" },
      organizations[0]!,
    );

    assert(
      backofficeRouteScopePath(backofficeRouteScopeFromResolvedScope(organizationScope)) ===
        "org/acme",
    );
    assert(
      backofficeRouteScopePath(backofficeRouteScopeFromResolvedScope(projectScope)) ===
        "project/acme%3Aproject_1",
    );
  });

  test("decodes route parameters without assigning runtime identity", () => {
    expect(
      backofficeRouteScopeFromParams({
        scopeKind: "project",
        scopeId: "acme:project_1",
      }),
    ).toEqual({ kind: "project", orgSlug: "acme", projectId: "project_1" });
  });

  test("requires organization metadata when resolving an ID-backed scope", () => {
    expect(() =>
      backofficeResolvedScopeFromRuntimeScope({ kind: "org", orgId: "org_123" }, null),
    ).toThrow("Backoffice resolved scope requires the scoped organization identity.");
  });

  test("resolves slugs before constructing canonical runtime identity", () => {
    const resolvedScope = resolveBackofficeRouteScope(
      { kind: "org", orgSlug: "acme" },
      organizations,
    );
    assert(resolvedScope);
    expect(backofficeRuntimeScopeFromResolvedScope(resolvedScope)).toEqual({
      kind: "org",
      orgId: "org_123",
    });
  });

  test("resolves ID-backed runtime scopes for slug-backed routes", async () => {
    const resolveOrganization = async (organizationId: string) => {
      const organization = organizations.find(({ id }) => id === organizationId);
      if (!organization) {
        throw new Error(`Organization '${organizationId}' could not be found.`);
      }
      return organization;
    };

    await expect(
      resolveBackofficeRuntimeScope(
        { kind: "project", orgId: "org_123", projectId: "project_1" },
        resolveOrganization,
      ),
    ).resolves.toEqual({
      kind: "project",
      organization: organizations[0],
      projectId: "project_1",
    });
  });

  test("does not resolve organization identity for organization-independent runtime scopes", async () => {
    const resolveOrganization = async () => {
      throw new Error("Organization lookup should not run.");
    };

    await expect(
      resolveBackofficeRuntimeScope({ kind: "user", userId: "user_123" }, resolveOrganization),
    ).resolves.toEqual({ kind: "user", userId: "user_123" });
  });

  test("rejects old organization id URLs without compatibility fallback", () => {
    assert(
      resolveBackofficeRouteScope({ kind: "org", orgSlug: "org_123" }, organizations) === null,
    );
    assert(
      resolveBackofficeRouteScope(
        { kind: "project", orgSlug: "org_123", projectId: "project_1" },
        organizations,
      ) === null,
    );
  });
});
