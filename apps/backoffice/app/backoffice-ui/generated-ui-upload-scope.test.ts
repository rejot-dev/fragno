import { describe, expect, test } from "vitest";

import {
  generatedUiUploadScopeSchema,
  resolveGeneratedUiUploadScope,
} from "./generated-ui-upload-scope";

describe("generated UI Upload scopes", () => {
  test("accepts the current context sentinel", () => {
    expect(generatedUiUploadScopeSchema.parse({ kind: "current" })).toEqual({ kind: "current" });
  });

  test("resolves the current sentinel to the authenticated routable scope", () => {
    const currentScope = { kind: "project" as const, orgId: "org-1", projectId: "project-1" };

    expect(resolveGeneratedUiUploadScope({ kind: "current" }, currentScope)).toEqual(currentScope);
  });

  test("requires a routable current context", () => {
    expect(() => resolveGeneratedUiUploadScope({ kind: "current" }, undefined)).toThrow(
      "does not support private file uploads",
    );
  });
});
