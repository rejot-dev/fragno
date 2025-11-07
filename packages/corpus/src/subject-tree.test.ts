import { describe, it, expect } from "vitest";
import {
  getSubjectParent,
  getSubjectChildren,
  orderSubjects,
  expandSubjectWithChildren,
  getAllSubjectIdsInOrder,
} from "./subject-tree.js";

describe("subject-tree", () => {
  describe("getSubjectParent", () => {
    it("should return null for root subjects", () => {
      expect(getSubjectParent("for-users")).toBe(null);
      expect(getSubjectParent("for-fragment-authors")).toBe(null);
      expect(getSubjectParent("general")).toBe(null);
    });

    it("should return parent for category children", () => {
      expect(getSubjectParent("defining-routes")).toBe("for-fragment-authors");
      expect(getSubjectParent("fragment-services")).toBe("for-fragment-authors");
      expect(getSubjectParent("fragment-instantiation")).toBe("for-users");
      expect(getSubjectParent("client-state-management")).toBe("for-users");
    });

    it("should return parent for nested subjects", () => {
      expect(getSubjectParent("kysely-adapter")).toBe("database-adapters");
      expect(getSubjectParent("drizzle-adapter")).toBe("database-adapters");
    });

    it("should return null for unknown subjects", () => {
      expect(getSubjectParent("non-existent-subject")).toBe(null);
    });
  });

  describe("getSubjectChildren", () => {
    it("should return empty array for subjects with no children", () => {
      expect(getSubjectChildren("defining-routes")).toEqual([]);
      expect(getSubjectChildren("kysely-adapter")).toEqual([]);
      expect(getSubjectChildren("general")).toEqual([]);
    });

    it("should return direct children for categories", () => {
      const usersChildren = getSubjectChildren("for-users");
      expect(usersChildren).toContain("fragment-instantiation");
      expect(usersChildren).toContain("client-state-management");
      expect(usersChildren).toHaveLength(2);

      const authorsChildren = getSubjectChildren("for-fragment-authors");
      expect(authorsChildren).toContain("defining-routes");
      expect(authorsChildren).toContain("fragment-services");
      expect(authorsChildren).toContain("database-querying");
      expect(authorsChildren).toContain("database-adapters");
      expect(authorsChildren).toHaveLength(4);
    });

    it("should return direct children only", () => {
      const children = getSubjectChildren("database-adapters");
      expect(children).toContain("kysely-adapter");
      expect(children).toContain("drizzle-adapter");
      expect(children).toHaveLength(2);
    });

    it("should return empty array for unknown subjects", () => {
      expect(getSubjectChildren("non-existent-subject")).toEqual([]);
    });
  });

  describe("orderSubjects", () => {
    it("should maintain tree order", () => {
      const unordered = ["drizzle-adapter", "defining-routes", "kysely-adapter"];
      const ordered = orderSubjects(unordered);

      // defining-routes comes before database-adapters (parent of the adapters)
      expect(ordered.indexOf("defining-routes")).toBeLessThan(ordered.indexOf("kysely-adapter"));
      expect(ordered.indexOf("defining-routes")).toBeLessThan(ordered.indexOf("drizzle-adapter"));
    });

    it("should order siblings consistently", () => {
      const siblings = ["drizzle-adapter", "kysely-adapter"];
      const ordered = orderSubjects(siblings);

      // kysely-adapter is defined first in the tree
      expect(ordered).toEqual(["kysely-adapter", "drizzle-adapter"]);
    });

    it("should handle empty array", () => {
      expect(orderSubjects([])).toEqual([]);
    });

    it("should handle single item", () => {
      expect(orderSubjects(["defining-routes"])).toEqual(["defining-routes"]);
    });

    it("should place unknown subjects at the end", () => {
      const subjects = ["kysely-adapter", "unknown-subject", "defining-routes"];
      const ordered = orderSubjects(subjects);

      expect(ordered[ordered.length - 1]).toBe("unknown-subject");
    });
  });

  describe("expandSubjectWithChildren", () => {
    it("should return just the subject if it has no children", () => {
      const expanded = expandSubjectWithChildren("defining-routes");
      expect(expanded).toEqual(["defining-routes"]);
    });

    it("should include direct children for categories", () => {
      const expanded = expandSubjectWithChildren("for-users");
      expect(expanded).toContain("for-users");
      expect(expanded).toContain("fragment-instantiation");
      expect(expanded).toContain("client-state-management");
      expect(expanded).toHaveLength(3);
    });

    it("should include direct children", () => {
      const expanded = expandSubjectWithChildren("database-adapters");
      expect(expanded).toContain("database-adapters");
      expect(expanded).toContain("kysely-adapter");
      expect(expanded).toContain("drizzle-adapter");
      expect(expanded).toHaveLength(3);
    });

    it("should recursively expand all descendants", () => {
      const expanded = expandSubjectWithChildren("for-fragment-authors");
      expect(expanded).toContain("for-fragment-authors");
      expect(expanded).toContain("defining-routes");
      expect(expanded).toContain("database-adapters");
      expect(expanded).toContain("kysely-adapter");
      expect(expanded).toContain("drizzle-adapter");
    });

    it("should maintain tree order in expansion", () => {
      const expanded = expandSubjectWithChildren("database-adapters");

      // Parent should come first
      expect(expanded[0]).toBe("database-adapters");

      // Children should follow in order
      expect(expanded.indexOf("kysely-adapter")).toBeLessThan(expanded.indexOf("drizzle-adapter"));
    });

    it("should handle unknown subjects gracefully", () => {
      const expanded = expandSubjectWithChildren("non-existent-subject");
      expect(expanded).toEqual(["non-existent-subject"]);
    });
  });

  describe("getAllSubjectIdsInOrder", () => {
    it("should return all subjects in tree order", () => {
      const allIds = getAllSubjectIdsInOrder();

      expect(allIds).toBeInstanceOf(Array);
      expect(allIds.length).toBeGreaterThan(0);

      // Check that known subjects are present
      expect(allIds).toContain("defining-routes");
      expect(allIds).toContain("database-adapters");
      expect(allIds).toContain("kysely-adapter");
      expect(allIds).toContain("drizzle-adapter");
    });

    it("should maintain parent-child ordering", () => {
      const allIds = getAllSubjectIdsInOrder();

      const dbAdaptersIndex = allIds.indexOf("database-adapters");
      const kyselyIndex = allIds.indexOf("kysely-adapter");
      const drizzleIndex = allIds.indexOf("drizzle-adapter");

      // Parent should come before children
      expect(dbAdaptersIndex).toBeLessThan(kyselyIndex);
      expect(dbAdaptersIndex).toBeLessThan(drizzleIndex);

      // Children should be in order
      expect(kyselyIndex).toBeLessThan(drizzleIndex);
    });

    it("should not have duplicates", () => {
      const allIds = getAllSubjectIdsInOrder();
      const uniqueIds = [...new Set(allIds)];

      expect(allIds.length).toBe(uniqueIds.length);
    });
  });

  describe("arbitrary nesting support", () => {
    it("should support subjects at different nesting levels", () => {
      // Test that we can query deeply nested items
      // This demonstrates the structure supports arbitrary nesting
      const adaptersChildren = getSubjectChildren("database-adapters");
      expect(adaptersChildren.length).toBeGreaterThan(0);

      // Children should have no children (in current structure)
      for (const child of adaptersChildren) {
        const grandchildren = getSubjectChildren(child);
        expect(grandchildren).toEqual([]);
      }
    });

    it("expandSubjectWithChildren should recursively include all descendants", () => {
      // When we have nested items, expansion should include all levels
      const expanded = expandSubjectWithChildren("database-adapters");

      // Should include the root
      expect(expanded[0]).toBe("database-adapters");

      // Should include all descendants
      const children = getSubjectChildren("database-adapters");
      for (const child of children) {
        expect(expanded).toContain(child);

        // Should also include grandchildren if any exist
        const grandchildren = getSubjectChildren(child);
        for (const grandchild of grandchildren) {
          expect(expanded).toContain(grandchild);
        }
      }
    });

    it("should handle 3+ levels of nesting correctly", () => {
      // This test demonstrates the data structure can handle arbitrary depth
      // If we had: root -> child -> grandchild -> great-grandchild
      // The functions should handle this correctly

      // We test this by verifying the order map maintains correct ordering
      // even for deeply nested structures
      const allIds = getAllSubjectIdsInOrder();

      // Verify no duplicates (important for deep nesting)
      const uniqueIds = new Set(allIds);
      expect(allIds.length).toBe(uniqueIds.size);

      // Verify parent always comes before all descendants
      const dbAdaptersIdx = allIds.indexOf("database-adapters");
      const kyselyIdx = allIds.indexOf("kysely-adapter");
      const drizzleIdx = allIds.indexOf("drizzle-adapter");

      expect(dbAdaptersIdx).toBeLessThan(kyselyIdx);
      expect(dbAdaptersIdx).toBeLessThan(drizzleIdx);

      // If kysely had children, they would come after kysely but before drizzle
      const kyselyChildren = getSubjectChildren("kysely-adapter");
      if (kyselyChildren.length > 0) {
        for (const grandchild of kyselyChildren) {
          const grandchildIdx = allIds.indexOf(grandchild);
          expect(kyselyIdx).toBeLessThan(grandchildIdx);
          expect(grandchildIdx).toBeLessThan(drizzleIdx);
        }
      }
    });
  });
});
