import { test, describe, expect, beforeEach, vi, assert, beforeAll } from "vitest";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
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

  const waitForOnSubscribe = async (email: string) => {
    const start = Date.now();
    while (
      !onSubscribeSpy.mock.calls.some((call) => call[0] === email) &&
      Date.now() - start < 1000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  // Reset database before each test for isolation
  beforeEach(async () => {
    await testContext.resetDatabase();
    await new Promise((resolve) => setTimeout(resolve, 20));
    onSubscribeSpy.mockClear();
  });

  describe("set up", () => {
    test("should have the correct $internal object", async () => {
      expect(fragment).toBeDefined();
      expect(fragment.$internal).toBeDefined();
      expect(fragment.$internal.deps).toBeDefined();
      expect(fragment.$internal.deps.schema).toBe(mailingListSchema);
      expect(fragment.$internal.deps.namespace).toBe("mailing_list");
      expect(fragment.$internal.deps.createUnitOfWork).toBeDefined();
      expect(fragment.$internal.options).toBeDefined();
    });
  });

  describe("Services", () => {
    describe("subscribe", () => {
      test("should add a new subscriber", async () => {
        // TODO(Wilco): would be nice to have a helper function for inContext -> uow
        const result = await fragment.inContext(function () {
          return this.handlerTx()
            .withServiceCalls(() => [services.subscribe("test@example.com")])
            .transform(({ serviceResult: [result] }) => result)
            .execute();
        });

        expect(result).toMatchObject({
          id: expect.any(String),
          email: "test@example.com",
          subscribedAt: expect.any(Date),
          alreadySubscribed: false,
        });
      }, 2000);

      test("should return existing subscriber if already subscribed", async () => {
        const initialSubscriber = await fragment.inContext(function () {
          return this.handlerTx()
            .withServiceCalls(() => [services.subscribe("test@example.com")])
            .transform(({ serviceResult: [result] }) => result)
            .execute();
        });

        expect(initialSubscriber).toMatchObject({
          id: expect.any(String),
          email: "test@example.com",
          subscribedAt: expect.any(Date),
          alreadySubscribed: false,
        });

        const resubscribe = await fragment.inContext(function () {
          return this.handlerTx()
            .withServiceCalls(() => [services.subscribe("test@example.com")])
            .transform(({ serviceResult: [result] }) => result)
            .execute();
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
      await fragment.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            services.subscribe("alice@example.com"),
            services.subscribe("bob@example.com"),
            services.subscribe("charlie@example.com"),
          ])
          .execute();
      });

      // First page with sortBy="email"
      const firstPage = await fragment.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            services.getSubscribers({
              sortBy: "email",
              sortOrder: "asc",
              pageSize: 1,
            }),
          ])
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      expect(firstPage.cursor).toBeDefined();

      // Try to get next page with different sortBy (should throw index mismatch)
      await expect(
        fragment.inContext(function () {
          return this.handlerTx()
            .withServiceCalls(() => [
              services.getSubscribers({
                sortBy: "subscribedAt", // Changed from "email"
                sortOrder: "asc",
                pageSize: 1,
                cursor: firstPage.cursor,
              }),
            ])
            .execute();
        }),
      ).rejects.toThrow(/Index mismatch/);
    });
  });

  describe("Routes", () => {
    beforeAll(async () => {
      await testContext.resetDatabase();
    });

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

        await drainDurableHooks(fragment);
        await waitForOnSubscribe("test@example.com");
        expect(onSubscribeSpy).toHaveBeenCalledWith("test@example.com");

        const result = await fragments["mailing-list"].db.find("subscriber", (b) =>
          b.whereIndex("primary"),
        );

        expect(result).toHaveLength(1);
        expect(result[0].email).toBe("test@example.com");
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
