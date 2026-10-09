import { describe, expect, test } from "vitest";

import {
  backofficeContextScopeFromRouteParams,
  backofficeContextScopeRouteId,
  backofficeContextScopeRoutePath,
  backofficeScopeFromRouteParams,
  backofficeScopeFromSinglePathSegment,
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

  test("round-trips system route scopes through the context codec", () => {
    expect(
      backofficeContextScopeFromRouteParams({ scopeKind: "system", scopeId: "system" }),
    ).toEqual({ kind: "system" });
    expect(() =>
      backofficeScopeFromRouteParams({ scopeKind: "system", scopeId: "system" }),
    ).toThrow("System scope is not routable here.");
  });

  test("rejects incomplete and malformed route scopes at acquisition", () => {
    expect(() => backofficeContextScopeFromRouteParams({ scopeKind: "org" })).toThrow(
      "Route scope requires both kind and id components.",
    );
    expect(() =>
      backofficeContextScopeFromRouteParams({ scopeKind: "system", scopeId: "other" }),
    ).toThrow("System scope requires the system id.");
  });

  test("accepts only routable scopes where resources are owned", () => {
    expect(backofficeScopeFromSinglePathSegment("org:org-1")).toEqual({
      kind: "org",
      orgId: "org-1",
    });
    expect(() => backofficeScopeFromSinglePathSegment("system")).toThrow(
      "System scope is not routable here.",
    );
  });
});
