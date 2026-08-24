import { describe, expect, test } from "vitest";

import {
  generatedUiUploadScopeSchema,
  resolveGeneratedUiUploadScope,
} from "./generated-ui-upload-scope";

const organization = { id: "org-1", slug: "acme" };
const currentScope = {
  kind: "project" as const,
  organization,
  projectId: "project-1",
};

describe("generated UI Upload scopes", () => {
  test("accepts the current context sentinel", () => {
    expect(generatedUiUploadScopeSchema.parse({ kind: "current" })).toEqual({ kind: "current" });
  });

  test("resolves the current sentinel to the authenticated resolved scope", () => {
    expect(resolveGeneratedUiUploadScope({ kind: "current" }, currentScope)).toEqual(currentScope);
  });

  test("attaches authenticated organization identity to an explicit project scope", () => {
    expect(
      resolveGeneratedUiUploadScope(
        { kind: "project", orgId: organization.id, projectId: "project-2" },
        currentScope,
      ),
    ).toEqual({ kind: "project", organization, projectId: "project-2" });
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
