import { describe, expect, test, assert } from "vitest";

import {
  backofficeContextScopeSchema,
  backofficeRoutableScopeSchema,
  backofficeScopePathSegment,
  BackofficeScopeParseError,
  isBackofficeScopeParseError,
  parseBackofficeScopePathSegment,
} from "./scope";

describe("Backoffice scopes", () => {
  test("schemas reject unknown fields, empty ids, and system scope where resources are owned", () => {
    assert(
      !backofficeRoutableScopeSchema.safeParse({
        kind: "project",
        orgId: "org-1",
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
    [{ kind: "project", orgId: "org:1", projectId: "p/2" } as const, "project:org%3A1:p%2F2"],
  ])("round-trips path segments with encoded delimiters for %#", (scope, segment) => {
    expect(backofficeScopePathSegment(scope)).toBe(segment);
    expect(parseBackofficeScopePathSegment(segment)).toEqual(scope);
  });

  test("rejects malformed segments instead of guessing a scope", () => {
    expect(() => parseBackofficeScopePathSegment("project:broken")).toThrow(
      "Project scope requires org and project id components.",
    );
    expect(() => parseBackofficeScopePathSegment("system:extra")).toThrow(
      "System scope does not accept id components.",
    );
    expect(() => parseBackofficeScopePathSegment("user:")).toThrow("Missing user id.");
    expect(() => parseBackofficeScopePathSegment("org:%E0%A4%A")).toThrow(
      "Invalid org id encoding.",
    );
    expect(() => parseBackofficeScopePathSegment("legacy-org-id")).toThrow(
      "Unknown scope kind 'legacy-org-id'.",
    );
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
