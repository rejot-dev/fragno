import { describe, expect, test, assert } from "vitest";

import { marketplaceVersionSchema } from "./contracts";
import { compareMarketplaceVersions } from "./version";

describe("compareMarketplaceVersions", () => {
  test.each([
    ["1.1.0", "1.0.0"],
    ["2.0.0", "1.99.99"],
    ["1.0.0", "1.0.0-beta.2"],
    ["1.0.0-beta.10", "1.0.0-beta.2"],
    ["1.0.0-rc.1", "1.0.0-beta.99"],
  ])("orders %s after %s", (newer, older) => {
    expect(compareMarketplaceVersions(newer, older)).toBeGreaterThan(0);
    expect(compareMarketplaceVersions(older, newer)).toBeLessThan(0);
  });

  test("treats identical versions as equal", () => {
    assert(compareMarketplaceVersions("1.2.3-beta.4", "1.2.3-beta.4") === 0);
  });

  test.each([
    ["01.0.0", "1.0.0"],
    ["1.0.0-01", "1.0.0-1"],
  ])("orders distinct legacy versions %s and %s deterministically", (left, right) => {
    const comparison = compareMarketplaceVersions(left, right);
    expect(comparison).not.toBe(0);
    expect(compareMarketplaceVersions(right, left)).toBe(-comparison);
  });
});

describe("marketplaceVersionSchema", () => {
  test.each(["0.0.0", "1.0.0", "2.1.0-beta.1", "1.0.0-0", "1.0.0-01alpha"])(
    "accepts canonical version %s",
    (version) => {
      expect(marketplaceVersionSchema.parse(version)).toBe(version);
    },
  );

  test.each(["01.0.0", "1.01.0", "1.0.01", "1.0.0-01", "1.0.0-alpha..1", "1.0.0-alpha."])(
    "rejects noncanonical version %s",
    (version) => {
      expect(() => marketplaceVersionSchema.parse(version)).toThrow();
    },
  );
});
