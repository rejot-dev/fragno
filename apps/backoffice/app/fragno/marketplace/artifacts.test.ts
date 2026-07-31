import { describe, expect, test, assert } from "vitest";

import {
  marketplaceListingArtifactFilePath,
  marketplaceVersionArtifactFilePath,
} from "./artifacts";

describe("marketplace artifact paths", () => {
  test("keeps version and listing files in distinct storage namespaces", () => {
    assert(marketplaceVersionArtifactFilePath("1.0.0", "README.md") === "1.0.0/README.md");
    assert(marketplaceListingArtifactFilePath("1.0.0", "README.md") === "1.0.0/.listing/README.md");
  });

  test("rejects version files in the reserved listing files directory", () => {
    expect(() => marketplaceVersionArtifactFilePath("1.0.0", ".listing/README.md")).toThrow(
      "uses the reserved listing files directory",
    );
  });
});
