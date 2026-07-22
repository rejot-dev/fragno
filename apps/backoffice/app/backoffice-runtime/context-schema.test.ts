import { describe, expect, test } from "vitest";

import { backofficeContextScopeSchema } from "./context-schema";

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

  test("rejects empty scope identifiers", () => {
    expect(() => backofficeContextScopeSchema.parse({ kind: "user", userId: "" })).toThrow();
  });
});
