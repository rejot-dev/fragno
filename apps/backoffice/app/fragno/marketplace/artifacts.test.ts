import { assert, describe, expect, test } from "vitest";

import { marketplaceRootArtifactFilePath, marketplaceVersionArtifactFilePath } from "./artifacts";

describe("marketplace artifact paths", () => {
  test("keeps listing files at the collection root and version files below their version", () => {
    assert(marketplaceRootArtifactFilePath("README.md") === "README.md");
    assert(marketplaceVersionArtifactFilePath("1.0.0", "README.md") === "1.0.0/README.md");
    assert(
      marketplaceVersionArtifactFilePath("1.0.0", "automations/example.workflow.js") ===
        "1.0.0/automations/example.workflow.js",
    );
  });

  test("rejects root files that conflict with version directories", () => {
    expect(() => marketplaceRootArtifactFilePath("1.0.0/README.md")).toThrow(
      "conflicts with a version directory",
    );
  });

  test("rejects invalid relative artifact paths", () => {
    expect(() => marketplaceVersionArtifactFilePath("1.0.0", "../README.md")).toThrow(
      "contains an invalid path segment",
    );
  });
});
