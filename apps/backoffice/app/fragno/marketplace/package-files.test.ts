import { assert, describe, expect, test } from "vitest";

import { marketplaceRootPackageFilePath, marketplaceVersionPackageFilePath } from "./package-files";

describe("marketplace package paths", () => {
  test("keeps listing files at the collection root and version files below their version", () => {
    assert(marketplaceRootPackageFilePath("README.md") === "README.md");
    assert(marketplaceVersionPackageFilePath("1.0.0", "README.md") === "1.0.0/README.md");
    assert(
      marketplaceVersionPackageFilePath("1.0.0", "automations/example.workflow.js") ===
        "1.0.0/automations/example.workflow.js",
    );
  });

  test("rejects root files that conflict with version directories", () => {
    expect(() => marketplaceRootPackageFilePath("1.0.0/README.md")).toThrow(
      "conflicts with a version directory",
    );
  });

  test("rejects invalid relative package paths", () => {
    expect(() => marketplaceVersionPackageFilePath("1.0.0", "../README.md")).toThrow(
      "contains an invalid path segment",
    );
  });
});
