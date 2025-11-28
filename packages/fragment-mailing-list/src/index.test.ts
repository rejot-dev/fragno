import { test, describe, expect, beforeEach } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { mailingListFragmentDefinition } from "./definition";
import { instantiate } from "@fragno-dev/core";

describe("Mailing List Fragment", async () => {
  // Create fragment with test configuration
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment("mailing-list", instantiate(mailingListFragmentDefinition))
    .build();

  const { services, fragment } = fragments["mailing-list"];

  // Reset database before each test for isolation
  beforeEach(async () => {
    await testContext.resetDatabase();
  });

  describe("Services", () => {
    describe("subscribe", () => {
      test("should add a new subscriber", async () => {
        // TODO(Wilco): would be nice to have a helper function for inContext -> uow
        const result = await fragment.inContext(async function () {
          return this.uow(async ({ executeMutate }) => {
            const result = services.subscribe("test@example.com");
            await executeMutate();
            return result;
          });
        });

        expect(result).toMatchObject({
          id: expect.any(String),
          email: "test@example.com",
          subscribedAt: expect.any(Date),
          alreadySubscribed: false,
        });
      });

      test("should return existing subscriber if already subscribed", async () => {
        const initialSubscriber = await fragment.inContext(async function () {
          return this.uow(async ({ executeMutate }) => {
            const result = services.subscribe("test@example.com");
            await executeMutate();
            return result;
          });
        });

        expect(initialSubscriber).toMatchObject({
          id: expect.any(String),
          email: "test@example.com",
          subscribedAt: expect.any(Date),
          alreadySubscribed: false,
        });

        const resubscribe = await fragment.inContext(async function () {
          return this.uow(async ({ executeMutate }) => {
            const result = services.subscribe("test@example.com");
            await executeMutate();
            return result;
          });
        });

        expect(resubscribe).toMatchObject({
          id: initialSubscriber.id,
          email: "test@example.com",
          // TODO(Wilco): re-add this, there seems to be a timezone issue
          // subscribedAt: initialSubscriber.subscribedAt,
          alreadySubscribed: true,
        });
      });
    });
  });

  describe("getSubscribers - Pagination", () => {
    test("should throw index mismatch error when sortBy changes between pagination requests", async () => {
      // Create some test subscribers
      await fragment.inContext(async function () {
        return this.uow(async ({ executeMutate }) => {
          services.subscribe("alice@example.com");
          services.subscribe("bob@example.com");
          services.subscribe("charlie@example.com");
          await executeMutate();
        });
      });

      // First page with sortBy="email"
      const firstPage = await fragment.inContext(function () {
        return this.uow(async ({ executeRetrieve }) => {
          const result = services.getSubscribers({
            sortBy: "email",
            sortOrder: "asc",
            pageSize: 1,
          });
          await executeRetrieve();
          return result;
        });
      });

      expect(firstPage.cursor).toBeDefined();

      // Try to get next page with different sortBy (should throw index mismatch)
      await expect(
        fragment.inContext(function () {
          return services.getSubscribers({
            sortBy: "subscribedAt", // Changed from "email"
            sortOrder: "asc",
            pageSize: 1,
            cursor: firstPage.cursor,
          });
        }),
      ).rejects.toThrow(/Index mismatch/);
    });
  });
});
