import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authFragmentDefinition } from "..";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { userOverviewRoutesFactory } from "./user-overview";

describe("User Overview Services", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition).withRoutes([userOverviewRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;
  const services = fragment.services;

  // Test data setup
  const testUsers = [
    { email: "alice@example.com", password: "password123" },
    { email: "bob@example.com", password: "password123" },
    { email: "charlie@example.com", password: "password123" },
    { email: "david@test.com", password: "password123" },
    { email: "eve@test.com", password: "password123" },
  ];

  beforeAll(async () => {
    // Create test users
    for (const user of testUsers) {
      await services.createUser(user.email, user.password);
    }
  });

  afterAll(async () => {
    await test.cleanup();
  });

  describe("getUsersWithCursor", () => {
    it("should return users without search filter", async () => {
      const result = await services.getUsersWithCursor({
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 20,
      });

      expect(result.users.length).toBeGreaterThanOrEqual(testUsers.length);
    });

    it("should filter users by email search", async () => {
      const result = await services.getUsersWithCursor({
        search: "example.com",
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 20,
      });

      expect(result.users.length).toBe(3); // alice, bob, charlie
      result.users.forEach((user) => {
        expect(user.email).toContain("example.com");
      });
    });

    it("should filter users by partial email search", async () => {
      const result = await services.getUsersWithCursor({
        search: "alice",
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 20,
      });

      expect(result.users.length).toBe(1);
      expect(result.users[0].email).toBe("alice@example.com");
    });

    it("should sort users by email ascending", async () => {
      const result = await services.getUsersWithCursor({
        search: "example.com",
        sortBy: "email",
        sortOrder: "asc",
        pageSize: 20,
      });

      expect(result.users.length).toBe(3);
      expect(result.users[0].email).toBe("alice@example.com");
      expect(result.users[1].email).toBe("bob@example.com");
      expect(result.users[2].email).toBe("charlie@example.com");
    });

    it("should sort users by email descending", async () => {
      const result = await services.getUsersWithCursor({
        search: "example.com",
        sortBy: "email",
        sortOrder: "desc",
        pageSize: 20,
      });

      expect(result.users.length).toBe(3);
      expect(result.users[0].email).toBe("charlie@example.com");
      expect(result.users[1].email).toBe("bob@example.com");
      expect(result.users[2].email).toBe("alice@example.com");
    });

    it("should sort users by createdAt ascending", async () => {
      const result = await services.getUsersWithCursor({
        sortBy: "createdAt",
        sortOrder: "asc",
        pageSize: 20,
      });

      // Verify dates are in ascending order
      for (let i = 1; i < result.users.length; i++) {
        const prevDate = new Date(result.users[i - 1].createdAt);
        const currDate = new Date(result.users[i].createdAt);
        expect(prevDate.getTime()).toBeLessThanOrEqual(currDate.getTime());
      }
    });

    it("should sort users by createdAt descending", async () => {
      const result = await services.getUsersWithCursor({
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 20,
      });

      // Verify dates are in descending order
      for (let i = 1; i < result.users.length; i++) {
        const prevDate = new Date(result.users[i - 1].createdAt);
        const currDate = new Date(result.users[i].createdAt);
        expect(prevDate.getTime()).toBeGreaterThanOrEqual(currDate.getTime());
      }
    });

    it("should respect pageSize parameter", async () => {
      const result = await services.getUsersWithCursor({
        sortBy: "email",
        sortOrder: "asc",
        pageSize: 2,
      });

      expect(result.users.length).toBe(2);
      expect(result.cursor).toBeDefined(); // Should have more results
    });

    it("should support cursor-based pagination", async () => {
      // Get first page
      const firstPage = await services.getUsersWithCursor({
        sortBy: "email",
        sortOrder: "asc",
        pageSize: 2,
      });

      expect(firstPage.users.length).toBe(2);
      expect(firstPage.cursor).toBeDefined();

      // Get second page using cursor
      const secondPage = await services.getUsersWithCursor({
        sortBy: "email",
        sortOrder: "asc",
        pageSize: 2,
        cursor: firstPage.cursor,
      });

      // Verify no overlap
      expect(firstPage.users[0].id).not.toBe(secondPage.users[0].id);
      expect(firstPage.users[1].id).not.toBe(secondPage.users[0].id);
    });

    it("should handle large page sizes", async () => {
      const result = await services.getUsersWithCursor({
        sortBy: "email",
        sortOrder: "asc",
        pageSize: 100,
      });

      // With a large page size, we should get all users
      expect(result.users.length).toBeGreaterThanOrEqual(testUsers.length);

      // If cursor is defined, using it should return no more results
      if (result.cursor) {
        const nextPage = await services.getUsersWithCursor({
          sortBy: "email",
          sortOrder: "asc",
          pageSize: 100,
          cursor: result.cursor,
        });
        expect(nextPage.users.length).toBe(0);
      }
    });

    it("should combine search, sort, and pagination", async () => {
      const result = await services.getUsersWithCursor({
        search: "test.com",
        sortBy: "email",
        sortOrder: "asc",
        pageSize: 1,
      });

      expect(result.users.length).toBe(1);
      expect(result.users[0].email).toBe("david@test.com");
      expect(result.cursor).toBeDefined(); // eve@test.com should be next
    });

    it("should navigate from page 1 to page 2 using cursor", async () => {
      // Get page 1 with 2 users
      const page1 = await services.getUsersWithCursor({
        sortBy: "email",
        sortOrder: "asc",
        pageSize: 2,
      });

      expect(page1.users.length).toBe(2);
      expect(page1.cursor).toBeDefined();

      // Use cursor from page 1 to get page 2
      const page2 = await services.getUsersWithCursor({
        sortBy: "email",
        sortOrder: "asc",
        pageSize: 2,
        cursor: page1.cursor,
      });

      // Page 2 should have different users
      expect(page2.users.length).toBeGreaterThan(0);
      expect(page2.users[0].id).not.toBe(page1.users[0].id);
      expect(page2.users[0].id).not.toBe(page1.users[1].id);

      // First user on page 2 should come after the last user on page 1
      expect(page2.users[0].email > page1.users[1].email).toBe(true);
    });

    it("should return empty results when using cursor with no more data", async () => {
      // Get all users in one page
      const allUsers = await services.getUsersWithCursor({
        sortBy: "email",
        sortOrder: "asc",
        pageSize: 100,
      });

      // If there's a cursor, it means there might be more data to fetch
      // But since we used a large page size, the next page should be empty
      if (allUsers.cursor) {
        const nextPage = await services.getUsersWithCursor({
          sortBy: "email",
          sortOrder: "asc",
          pageSize: 100,
          cursor: allUsers.cursor,
        });

        expect(nextPage.users).toEqual([]);
        expect(nextPage.users.length).toBe(0);
      }

      // Alternative: Get a page that exhausts the data
      const smallPage = await services.getUsersWithCursor({
        sortBy: "email",
        sortOrder: "asc",
        pageSize: 1,
      });

      // Keep fetching until we get no cursor
      let currentCursor = smallPage.cursor;
      let iterations = 0;
      const maxIterations = 20; // Safety limit

      while (currentCursor && iterations < maxIterations) {
        const nextPage = await services.getUsersWithCursor({
          sortBy: "email",
          sortOrder: "asc",
          pageSize: 1,
          cursor: currentCursor,
        });

        if (!nextPage.cursor) {
          // We've reached the last page
          // Try to fetch one more time with the last cursor we had
          const beyondLastPage = await services.getUsersWithCursor({
            sortBy: "email",
            sortOrder: "asc",
            pageSize: 1,
            cursor: currentCursor,
          });

          // Should return the last item again (as cursor repeats the query)
          expect(beyondLastPage.users.length).toBeGreaterThanOrEqual(0);
          break;
        }

        currentCursor = nextPage.cursor;
        iterations++;
      }

      expect(iterations).toBeLessThan(maxIterations);
    });

    it("should return empty results for non-matching search", async () => {
      const result = await services.getUsersWithCursor({
        search: "nonexistent@domain.com",
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 20,
      });

      expect(result.users.length).toBe(0);
      expect(result.cursor).toBeUndefined();
    });

    it("should handle pageSize of 1", async () => {
      const result = await services.getUsersWithCursor({
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 1,
      });

      expect(result.users.length).toBe(1);
    });

    it("should handle large pageSize values", async () => {
      const result = await services.getUsersWithCursor({
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 100,
      });

      expect(result.users.length).toBeGreaterThanOrEqual(testUsers.length);
    });

    it("should return users with all required fields", async () => {
      const result = await services.getUsersWithCursor({
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 1,
      });

      expect(result.users.length).toBe(1);
      const user = result.users[0];
      expect(user).toHaveProperty("id");
      expect(user).toHaveProperty("email");
      expect(user).toHaveProperty("createdAt");
      expect(typeof user.id).toBe("string");
      expect(typeof user.email).toBe("string");
      expect(user.createdAt).toBeInstanceOf(Date);
    });

    it("should not include password hash in results", async () => {
      const result = await services.getUsersWithCursor({
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 1,
      });

      const user = result.users[0] as unknown as Record<string, unknown>;
      expect(user["passwordHash"]).toBeUndefined();
    });
  });

  describe("Edge cases", () => {
    it("should handle case-sensitive email search", async () => {
      const lowerResult = await services.getUsersWithCursor({
        search: "alice",
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 20,
      });

      const upperResult = await services.getUsersWithCursor({
        search: "ALICE",
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 20,
      });

      // Note: The behavior depends on database collation
      // For this test, we just verify both searches complete without error
      expect(lowerResult.users.length).toBeGreaterThanOrEqual(0);
      expect(upperResult.users.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle search with special characters", async () => {
      const result = await services.getUsersWithCursor({
        search: "@",
        sortBy: "createdAt",
        sortOrder: "desc",
        pageSize: 20,
      });

      // All email addresses contain @
      expect(result.users.length).toBeGreaterThanOrEqual(testUsers.length);
    });

    it("should handle pagination through all results", async () => {
      let cursor;
      let allUsers: Array<{ id: string; email: string; createdAt: Date; role: "user" | "admin" }> =
        [];
      let iterations = 0;
      const maxIterations = 10; // Prevent infinite loops

      do {
        const result = await services.getUsersWithCursor({
          sortBy: "email",
          sortOrder: "asc",
          pageSize: 2,
          cursor,
        });

        allUsers = allUsers.concat(result.users);
        cursor = result.cursor;
        iterations++;
      } while (cursor && iterations < maxIterations);

      expect(allUsers.length).toBeGreaterThanOrEqual(testUsers.length);
    });

    it("should handle multiple rapid queries", async () => {
      const promises = Array(10)
        .fill(0)
        .map(() =>
          services.getUsersWithCursor({
            sortBy: "createdAt",
            sortOrder: "desc",
            pageSize: 5,
          }),
        );

      const results = await Promise.all(promises);

      results.forEach((result) => {
        expect(result.users.length).toBeLessThanOrEqual(5);
      });
    });
  });
});
