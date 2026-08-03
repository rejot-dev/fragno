import { describe, expect, test, assert } from "vitest";

import {
  backofficeContextScopeFromSinglePathSegment,
  backofficeContextScopeRouteId,
  backofficeContextScopeRoutePath,
  backofficeContextScopeSinglePathSegment,
  backofficeScopeFromRouteParams,
  backofficeScopeFromSinglePathSegment,
  backofficeScopeSinglePathSegment,
} from "./scope-codec";

describe("backoffice scope codec", () => {
  test("round-trips route scope ids with encoded delimiters", () => {
    const project = { kind: "project" as const, orgId: "org:one", projectId: "proj~two" };
    const routeId = backofficeContextScopeRouteId(project);

    expect(routeId).toBe("org%3Aone:proj~two");
    expect(backofficeScopeFromRouteParams({ scopeKind: "project", scopeId: routeId })).toEqual(
      project,
    );
  });

  test("requires explicit kind tags for single path segments", () => {
    expect(backofficeScopeFromSinglePathSegment("user:alice")).toEqual({
      kind: "user",
      userId: "alice",
    });
    expect(backofficeScopeFromSinglePathSegment("org:user%3Aalice")).toEqual({
      kind: "org",
      orgId: "user:alice",
    });
    assert(
      backofficeScopeSinglePathSegment({ kind: "project", orgId: "org:1", projectId: "p/2" }) ===
        "project:org%3A1:p%2F2",
    );
  });

  test.each([
    [{ kind: "system" } as const, "system", "system/system"],
    [{ kind: "org", orgId: "org/one" } as const, "org%2Fone", "org/org%252Fone"],
    [{ kind: "user", userId: "user:one" } as const, "user%3Aone", "user/user%253Aone"],
    [
      { kind: "project", orgId: "org-1", projectId: "project/one" } as const,
      "org-1:project%2Fone",
      "project/org-1%3Aproject%252Fone",
    ],
  ])("builds route identifiers and paths for %#", (scope, expectedId, expectedPath) => {
    expect(backofficeContextScopeRouteId(scope)).toBe(expectedId);
    expect(backofficeContextScopeRoutePath(scope)).toBe(expectedPath);
  });

  test("supports system scopes for object-address metadata and public callbacks", () => {
    assert(backofficeContextScopeSinglePathSegment({ kind: "system" }) === "system");
    expect(backofficeContextScopeFromSinglePathSegment("system")).toEqual({ kind: "system" });
    expect(() => backofficeScopeFromSinglePathSegment("system")).toThrow(
      "System scope is not routable here.",
    );
  });

  test("throws for malformed scope segments instead of falling back to org scope", () => {
    expect(() => backofficeScopeFromSinglePathSegment("project:broken")).toThrow(
      "Project scope requires org and project id components.",
    );
    expect(() => backofficeScopeFromSinglePathSegment("user:")).toThrow("Missing user id.");
    expect(() => backofficeScopeFromSinglePathSegment("org:%E0%A4%A")).toThrow(
      "Invalid org id encoding.",
    );
    expect(() => backofficeScopeFromSinglePathSegment("legacy-org-id")).toThrow(
      "Unknown scope kind 'legacy-org-id'.",
    );
  });
});
