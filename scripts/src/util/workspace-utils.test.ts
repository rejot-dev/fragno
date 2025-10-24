import { describe, expect, it } from "vitest";
import {
  findPackageDirectory,
  getAllWorkspacePackages,
  getNonPrivatePackages,
} from "./workspace-utils.js";

describe("workspace-utils", () => {
  describe("getAllWorkspacePackages", () => {
    it("should return an array of workspace packages with correct structure", () => {
      const packages = getAllWorkspacePackages();

      expect(packages).toBeInstanceOf(Array);
      expect(packages.length).toBeGreaterThan(0);

      // Verify structure and known packages
      const packageNames = packages.map((pkg) => pkg.pkgData.name);
      expect(packageNames).toContain("@fragno-dev/core");
      expect(packageNames).toContain("@fragno-dev/node");

      // Verify first package has correct structure
      const pkg = packages[0];
      expect(pkg).toHaveProperty("path");
      expect(pkg).toHaveProperty("pkgData");
      expect(typeof pkg.path).toBe("string");
      expect(typeof pkg.pkgData.name).toBe("string");
      expect(typeof pkg.pkgData.private).toBe("boolean");
    });
  });

  describe("getNonPrivatePackages", () => {
    it("should return only non-private packages", () => {
      const packages = getNonPrivatePackages();

      expect(packages).toBeInstanceOf(Array);
      expect(packages.length).toBeGreaterThan(0);

      // All packages should be non-private
      for (const pkg of packages) {
        expect(pkg.pkgData.private).toBe(false);
      }

      // Should include known public packages
      const packageNames = packages.map((pkg) => pkg.pkgData.name);
      expect(packageNames).toContain("@fragno-dev/core");
    });
  });

  describe("findPackageDirectory", () => {
    it("should find existing package directory", () => {
      const fragnoDir = findPackageDirectory("@fragno-dev/core");
      expect(fragnoDir).not.toBeNull();
      expect(fragnoDir).toContain("packages/fragno");
    });
  });
});
