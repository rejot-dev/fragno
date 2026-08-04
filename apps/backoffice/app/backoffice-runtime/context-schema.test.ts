import { describe, expect, test, assert } from "vitest";

import { backofficeContextScopeSchema, backofficeRoutableScopeSchema } from "./context-schema";

describe("Backoffice context scope schema", () => {
  test("validates every context scope kind", () => {
    expect(
      [
        { kind: "system" },
        { kind: "org", orgId: "org-1" },
        { kind: "user", userId: "user-1" },
        { kind: "project", orgId: "org-1", projectId: "project-1" },
      ].map((scope) => backofficeContextScopeSchema.parse(scope)),
    ).toHaveLength(4);
  });

  test("validates only routable scope kinds for scoped resources", () => {
    expect(
      backofficeRoutableScopeSchema.parse({
        kind: "project",
        orgId: "org-1",
        projectId: "project-1",
      }),
    ).toEqual({ kind: "project", orgId: "org-1", projectId: "project-1" });
    assert(!backofficeRoutableScopeSchema.safeParse({ kind: "system" }).success);
  });

  test("rejects empty scope identifiers", () => {
    expect(() => backofficeContextScopeSchema.parse({ kind: "user", userId: "" })).toThrow();
  });
});
