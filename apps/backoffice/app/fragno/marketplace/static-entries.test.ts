import { describe, expect, test } from "vitest";

import { marketplaceManifestSchema } from "./static-entries";

describe("static Marketplace entries", () => {
  test("rejects duplicate parsed manifest versions", () => {
    expect(() =>
      marketplaceManifestSchema.parse({
        owner: { scope: { kind: "system" }, publisherName: "Fragno" },
        slug: "duplicate-version-test",
        metadata: {
          name: "Duplicate version test",
          summary: "Reject duplicate semantic versions in static manifests.",
          description:
            "Static Marketplace manifests must identify each semantic version exactly once.",
          category: "developer-tools",
          tags: [],
        },
        versions: ["1.0.0", " 1.0.0 "],
      }),
    ).toThrow("Marketplace manifest versions must be unique.");
  });
});
