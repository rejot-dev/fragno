import { describe, expect, test, assert } from "vitest";

import {
  backofficePublicScopeFromRuntimeScope,
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
} from "./resolved-scope";
import {
  backofficePublicScopePathSegment,
  backofficeRouteScopeFromParams,
  backofficeRouteScopePath,
} from "./route-scope";

// Page and public URLs never name the jurisdiction; runtime scopes always do.
const organization = { id: "org_123", slug: "acme", jurisdiction: "eu" as const };
const project = { id: "project_1", slug: "website" };
const lookups = {
  organizations: [organization],
  findUser: async () => null,
  isAppInstalled: async () => true,
  findProject: async (_owner: unknown, slug: string) => (slug === project.slug ? project : null),
};

describe("Backoffice route scope", () => {
  test("names projects by slug in page URLs and by ID at runtime", async () => {
    const resolution = await resolveBackofficeRouteScope(
      backofficeRouteScopeFromParams({ scopeKind: "project", scopeId: "org:acme:website" })!,
      lookups,
    );
    expect(resolution).toEqual({
      status: "resolved",
      scope: { kind: "project", owner: { kind: "org", organization }, project },
    });
    if (resolution.status !== "resolved") {
      throw new Error("Expected the project scope to resolve.");
    }

    assert(
      backofficeRouteScopePath(backofficeRouteScopeFromResolvedScope(resolution.scope)) ===
        "project/org:acme:website",
    );
    expect(backofficeRuntimeScopeFromResolvedScope(resolution.scope)).toEqual({
      kind: "project",
      owner: { kind: "org", orgId: "org_123", jurisdiction: "eu" },
      projectId: "project_1",
    });
  });

  test("keeps project IDs in public fragment URLs, which external services store", () => {
    assert(
      backofficePublicScopePathSegment(
        backofficePublicScopeFromRuntimeScope(
          {
            kind: "project",
            owner: { kind: "org", orgId: "org_123", jurisdiction: "eu" },
            projectId: "project_1",
          },
          organization,
        ),
      ) === "project:org:acme:project_1",
    );
  });

  test.each([
    [{ kind: "org", orgSlug: "org_123" } as const, "organization-not-found"],
    [
      {
        kind: "project",
        owner: { kind: "org", orgSlug: "acme" },
        projectSlug: "project_1",
      } as const,
      "project-not-found",
    ],
  ])("rejects IDs where URLs name slugs: %o", async (routeScope, status) => {
    await expect(resolveBackofficeRouteScope(routeScope, lookups)).resolves.toMatchObject({
      status,
    });
  });
});
