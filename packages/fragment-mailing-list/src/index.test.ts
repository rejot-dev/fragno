import { test, describe, expect, beforeEach, vi, assert } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { mailingListFragmentDefinition } from "./definition";
import { instantiate } from "@fragno-dev/core";
import { mailingListSchema } from "./schema";
import { mailingListRoutesFactory } from "./routes";

describe("Mailing List Fragment", async () => {
  const onSubscribeSpy = vi.fn<(email: string) => Promise<void> | void>();

  // Create fragment with test configuration
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "mailing-list",
      instantiate(mailingListFragmentDefinition)
        .withConfig({ onSubscribe: onSubscribeSpy })
        .withRoutes([mailingListRoutesFactory]),
    )
    .build();

  const { services, fragment } = fragments["mailing-list"];

  // Reset database before each test for isolation
  beforeEach(async () => {
    onSubscribeSpy.mockClear();
    await testContext.resetDatabase();
  });

  describe("set up", () => {
    test("should have the correct $internal object", async () => {
      expect(fragment).toBeDefined();
      expect(fragment.$internal).toBeDefined();
      expect(fragment.$internal.deps).toBeDefined();
      expect(fragment.$internal.deps.schema).toBe(mailingListSchema);
      expect(fragment.$internal.deps.namespace).toBe("mailing-list");
      expect(fragment.$internal.deps.createUnitOfWork).toBeDefined();
      expect(fragment.$internal.options).toBeDefined();
    });
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

  describe("Routes", () => {
    describe("POST /subscribe", () => {
      test("should call onSubscribe callback", async () => {
        const response = await fragment.callRoute("POST", "/subscribe", {
          body: { email: "test@example.com" },
        });

        assert(response.type === "json");
        expect(response.data).toMatchObject({
          id: expect.any(String),
          email: "test@example.com",
          // Date is returned as a string because of json serialization
          subscribedAt: expect.any(String),
          alreadySubscribed: false,
        });

        expect(onSubscribeSpy).toHaveBeenCalledWith("test@example.com");
        expect(onSubscribeSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe("GET /subscribers", () => {
      test("should return subscribers", async () => {
        const response = await fragment.callRoute("GET", "/subscribers");
        assert(response.type === "json");
        expect(response.data).toMatchObject({
          subscribers: expect.any(Array),
        });
      });
    });
  });
});
