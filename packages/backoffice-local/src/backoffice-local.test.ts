import { describe, expect, it } from "vitest";

import { parseBackofficeScope } from "./backoffice-local.js";

describe("parseBackofficeScope", () => {
  it("parses encoded organization and project identifiers", () => {
    expect(parseBackofficeScope("project:org%2Fone:project%3Atwo")).toEqual({
      kind: "project",
      orgId: "org/one",
      projectId: "project:two",
    });
  });

  it("rejects unsupported scope shapes", () => {
    expect(() => parseBackofficeScope("project:missing-project")).toThrow(
      "Invalid Backoffice scope",
    );
  });
});
