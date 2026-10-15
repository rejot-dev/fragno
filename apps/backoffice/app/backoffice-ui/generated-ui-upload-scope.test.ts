import { describe, expect, test } from "vitest";

import {
  generatedUiUploadScopeSchema,
  resolveGeneratedUiUploadScope,
} from "./generated-ui-upload-scope";

const currentScope = {
  kind: "project" as const,
  owner: { kind: "org" as const, orgId: "org-1" },
  projectId: "project-1",
};

describe("generated UI Upload scopes", () => {
  test("accepts the current context sentinel", () => {
    expect(generatedUiUploadScopeSchema.parse({ kind: "current" })).toEqual({ kind: "current" });
  });

  test("resolves the current sentinel to the current scope", () => {
    expect(resolveGeneratedUiUploadScope({ kind: "current" }, currentScope)).toEqual(currentScope);
  });

  test("accepts an explicit project scope in the current organization", () => {
    const projectScope = {
      kind: "project" as const,
      owner: { kind: "org" as const, orgId: "org-1" },
      projectId: "project-2",
    };
    expect(resolveGeneratedUiUploadScope(projectScope, currentScope)).toEqual(projectScope);
  });

  test("rejects an explicit scope for another organization", () => {
    expect(() =>
      resolveGeneratedUiUploadScope({ kind: "org", orgId: "org-2" }, currentScope),
    ).toThrow("cannot target another organization");
  });

  test("requires a routable current context", () => {
    expect(() => resolveGeneratedUiUploadScope({ kind: "current" }, undefined)).toThrow(
      "does not support private file uploads",
    );
  });
});
