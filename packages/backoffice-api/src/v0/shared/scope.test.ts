import { describe, expect, test, assert } from "vitest";

import {
  backofficeContextScopeSchema,
  backofficeScopeContains,
  backofficeScopeIdCodec,
  backofficeScopeOrganization,
  formatBackofficeScopeRoutePath,
  parseBackofficeScopeRouteParams,
  backofficeRoutableScopeSchema,
  backofficeScopePathSegment,
  BackofficeScopeParseError,
  isBackofficeScopeParseError,
  mapBackofficeScopeNames,
  parseBackofficeScopePathSegment,
} from "./scope";

describe("Backoffice scopes", () => {
  test("schemas reject unknown fields, empty ids, and system scope where resources are owned", () => {
    assert(
      !backofficeRoutableScopeSchema.safeParse({
        kind: "project",
        owner: { kind: "org", orgId: "org-1" },
        projectId: "project-1",
        ignored: true,
      }).success,
    );
    assert(!backofficeRoutableScopeSchema.safeParse({ kind: "system" }).success);
    assert(!backofficeContextScopeSchema.safeParse({ kind: "user", userId: "" }).success);
  });

  test.each([
    [{ kind: "system" } as const, "system"],
    [{ kind: "org", orgId: "user:alice" } as const, "org:user%3Aalice"],
    [{ kind: "user", userId: "alice" } as const, "user:alice"],
    [
      { kind: "project", owner: { kind: "org", orgId: "org:1" }, projectId: "p/2" } as const,
      "project:org:org%3A1:p%2F2",
    ],
  ])("round-trips path segments with encoded delimiters for %#", (scope, segment) => {
    expect(backofficeScopePathSegment(scope)).toBe(segment);
    expect(parseBackofficeScopePathSegment(segment)).toEqual(scope);
  });

  test.each([
    [{ kind: "system" } as const, "system/system"],
    [{ kind: "org", orgId: "user:alice" } as const, "org/user%253Aalice"],
    [
      { kind: "project", owner: { kind: "org", orgId: "org-1" }, projectId: "p-2" } as const,
      "project/org:org-1:p-2",
    ],
    [
      { kind: "project", owner: { kind: "org", orgId: "org:1" }, projectId: "p/2" } as const,
      "project/org:org%253A1:p%252F2",
    ],
  ])("round-trips route paths through once-decoded route params for %#", (scope, path) => {
    expect(formatBackofficeScopeRoutePath(scope, backofficeScopeIdCodec)).toBe(path);
    const [scopeKind, scopeId] = path.split("/").map(decodeURIComponent);
    expect(
      parseBackofficeScopeRouteParams(
        { scopeKind: scopeKind ?? "", scopeId: scopeId ?? "" },
        backofficeScopeIdCodec,
      ),
    ).toEqual(scope);
  });

  test("rejects malformed segments instead of guessing a scope", () => {
    expect(() => parseBackofficeScopePathSegment("project")).toThrow(
      "Project scope requires an owner scope.",
    );
    expect(() => parseBackofficeScopePathSegment("project:org:org-1")).toThrow(
      "Missing project id.",
    );
    // The segment format before projects named their owner.
    expect(() => parseBackofficeScopePathSegment("project:org-1:project-1")).toThrow(
      "Unknown scope kind 'org-1'.",
    );
    expect(() => parseBackofficeScopePathSegment("project:user:alice:project-1")).toThrow(
      "User scope cannot own a project.",
    );
    expect(() => parseBackofficeScopePathSegment("project:org:org-1:project-1:extra")).toThrow(
      "Project scope has unexpected components after it.",
    );
    expect(() => parseBackofficeScopePathSegment("system:extra")).toThrow(
      "System scope has unexpected components after it.",
    );
    expect(() => parseBackofficeScopePathSegment("user:")).toThrow("Missing user id.");
    expect(() => parseBackofficeScopePathSegment("org:%E0%A4%A")).toThrow(
      "Invalid org id encoding.",
    );
    expect(() => parseBackofficeScopePathSegment("legacy-org-id")).toThrow(
      "Unknown scope kind 'legacy-org-id'.",
    );
  });

  test("a restriction contains its own scope and the projects it owns", () => {
    const acme = { kind: "org", orgId: "acme" } as const;
    const website = { kind: "project", owner: acme, projectId: "website" } as const;
    assert(backofficeScopeContains(acme, website));
    assert(backofficeScopeContains(website, website));
    assert(!backofficeScopeContains(website, acme));
    assert(!backofficeScopeContains({ kind: "org", orgId: "beta" }, website));
    assert(!backofficeScopeContains({ kind: "user", userId: "acme" }, website));
  });

  test("renames a project's owner along with the project", () => {
    const website = {
      kind: "project",
      owner: { kind: "org", orgId: "org-1" },
      projectId: "project-1",
    } as const;
    const renamed = mapBackofficeScopeNames(website, {
      organization: ({ orgId }) => ({ orgSlug: `slug-of-${orgId}` }),
      project: ({ projectId }) => ({ projectSlug: `slug-of-${projectId}` }),
    });
    expect(renamed).toEqual({
      kind: "project",
      owner: { kind: "org", orgSlug: "slug-of-org-1" },
      projectSlug: "slug-of-project-1",
    });
    expect(backofficeScopeOrganization(renamed)).toEqual({ kind: "org", orgSlug: "slug-of-org-1" });
  });

  test("recognizes parse errors across module and RPC boundaries", () => {
    assert(isBackofficeScopeParseError(new BackofficeScopeParseError("Invalid scope.")));
    assert(
      isBackofficeScopeParseError(
        Object.assign(new Error("Invalid scope."), { code: "INVALID_BACKOFFICE_SCOPE" }),
      ),
    );
    assert(!isBackofficeScopeParseError(new Error("Other failure.")));
  });
});
