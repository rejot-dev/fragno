import { test, describe, expect, beforeEach, vi } from "vitest";
import { createDatabaseFragmentForTest } from "@fragno-dev/test";
import { stripeFragmentDefinition } from "./index";
import type Stripe from "stripe";

describe("Stripe Fragment Services", async () => {
  // Mock resolveEntityFromRequest callback
  const mockResolveEntityFromRequest = vi.fn().mockResolvedValue({
    referenceId: "test_user",
    stripeCustomerId: "cus_test",
    customerEmail: "test@example.com",
    subscriptionId: undefined,
    stripeMetadata: {},
  });

  // Create fragment with test configuration
  const { fragment, test: testContext } = await createDatabaseFragmentForTest(
    {
      definition: stripeFragmentDefinition,
      routes: [],
      config: {
        stripeSecretKey: "sk_test_mock_key",
        webhookSecret: "whsec_test_mock_secret",
        subscriptions: {
          enabled: true,
        },
        enableAdminRoutes: true,
        resolveEntityFromRequest: mockResolveEntityFromRequest,
        onStripeCustomerCreated: async () => {
          // Mock callback for tests
        },
      },
    },
    {
      adapter: { type: "kysely-sqlite" },
    },
  );

  // Reset database before each test for isolation
  beforeEach(async () => {
    await testContext.resetDatabase();
  });

  describe("createSubscription", () => {
    test("should create a new subscription", async () => {
      const subscriptionData = {
        referenceId: "user_123",
        stripePriceId: "price_123",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        status: "active" as Stripe.Subscription.Status,
        periodStart: new Date("2024-01-01"),
        periodEnd: new Date("2024-02-01"),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      };

      const subscriptionId = await fragment.services.createSubscription(subscriptionData);

      expect(subscriptionId).toEqual(expect.any(String));

      // Verify the subscription was created correctly
      const created = await fragment.services.getSubscriptionById(subscriptionId);
      expect(created).toMatchObject({
        id: subscriptionId,
        referenceId: "user_123",
        stripePriceId: "price_123",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        status: "active",
      });
    });

    test("should create subscription with default values", async () => {
      const subscriptionData = {
        referenceId: "user_456",
        stripePriceId: "price_456",
        stripeCustomerId: "cus_456",
        stripeSubscriptionId: "sub_456",
        status: "incomplete" as Stripe.Subscription.Status,
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: null,
      };

      const subscriptionId = await fragment.services.createSubscription(subscriptionData);

      expect(subscriptionId).toEqual(expect.any(String));

      // Verify the subscription was created correctly
      const created = await fragment.services.getSubscriptionById(subscriptionId);
      expect(created).toMatchObject({
        id: subscriptionId,
        status: "incomplete",
        cancelAtPeriodEnd: false,
      });
    });
  });

  describe("getSubscriptionByStripeId", () => {
    test("should retrieve subscription by Stripe subscription ID", async () => {
      await fragment.services.createSubscription({
        referenceId: "user_123",
        stripePriceId: "price_123",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_unique_123",
        status: "active" as Stripe.Subscription.Status,
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      });

      const result = await fragment.services.getSubscriptionByStripeId("sub_unique_123");

      expect(result).not.toBeNull();
      expect(result?.stripeSubscriptionId).toBe("sub_unique_123");
      expect(result?.status).toBe("active");
    });

    test("should return null for non-existent subscription", async () => {
      const result = await fragment.services.getSubscriptionByStripeId("sub_nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("getSubscriptionsByStripeCustomerId", () => {
    test("should retrieve subscriptions by Stripe customer ID", async () => {
      await fragment.services.createSubscription({
        referenceId: "user_123",
        stripePriceId: "price_123",
        stripeCustomerId: "cus_shared_123",
        stripeSubscriptionId: "sub_123",
        status: "active" as Stripe.Subscription.Status,
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      });

      await fragment.services.createSubscription({
        referenceId: "user_123",
        stripePriceId: "price_456",
        stripeCustomerId: "cus_shared_123",
        stripeSubscriptionId: "sub_456",
        status: "trialing" as Stripe.Subscription.Status,
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 2,
      });

      const results = await fragment.services.getSubscriptionsByStripeCustomerId("cus_shared_123");

      expect(results).toHaveLength(2);
      expect(results[0].stripeCustomerId).toBe("cus_shared_123");
      expect(results[1].stripeCustomerId).toBe("cus_shared_123");
    });

    test("should return empty array for non-existent customer", async () => {
      const results = await fragment.services.getSubscriptionsByStripeCustomerId("cus_nonexistent");

      expect(results).toEqual([]);
    });
  });

  describe("getSubscriptionById", () => {
    test("should retrieve subscription by internal ID", async () => {
      const created = await fragment.services.createSubscription({
        referenceId: "user_123",
        stripePriceId: "price_123",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        status: "active" as Stripe.Subscription.Status,
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      });

      const result = await fragment.services.getSubscriptionById(created);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(created);
      expect(result?.stripeSubscriptionId).toBe("sub_123");
    });

    test("should return null for non-existent ID", async () => {
      const result = await fragment.services.getSubscriptionById("nonexistent_id");

      expect(result).toBeNull();
    });
  });

  describe("getSubscriptionsByReferenceId", () => {
    test("should retrieve subscription by reference ID", async () => {
      await fragment.services.createSubscription({
        referenceId: "user_unique_789",
        stripePriceId: "price_123",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        status: "active" as Stripe.Subscription.Status,
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      });

      const result = await fragment.services.getSubscriptionsByReferenceId("user_unique_789");

      expect(result).toHaveLength(1);
      expect(result[0].referenceId).toBe("user_unique_789");
    });

    test("should return empty array for non-existent reference ID", async () => {
      const result = await fragment.services.getSubscriptionsByReferenceId("user_nonexistent");

      expect(result).toEqual([]);
    });
  });

  describe("updateSubscription", () => {
    test("should update subscription fields", async () => {
      const created = await fragment.services.createSubscription({
        referenceId: "user_123",
        stripePriceId: "price_123",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        status: "active" as Stripe.Subscription.Status,
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      });

      await fragment.services.updateSubscription(created, {
        status: "canceled" as Stripe.Subscription.Status,
        cancelAtPeriodEnd: true,
        seats: 2,
      });

      const updated = await fragment.services.getSubscriptionById(created);

      expect(updated).not.toBeNull();
      expect(updated?.status).toBe("canceled");
      expect(updated?.cancelAtPeriodEnd).toBe(true);
      expect(updated?.seats).toBe(2);
    });

    test("should update partial fields", async () => {
      const created = await fragment.services.createSubscription({
        referenceId: "user_123",
        stripePriceId: "price_123",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        status: "active" as Stripe.Subscription.Status,
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      });

      await fragment.services.updateSubscription(created, {
        seats: 5,
      });

      const updated = await fragment.services.getSubscriptionById(created);

      expect(updated?.seats).toBe(5);
      expect(updated?.status).toBe("active"); // Other fields unchanged
    });
  });

  describe("deleteSubscription", () => {
    test("should delete subscription", async () => {
      const created = await fragment.services.createSubscription({
        referenceId: "user_123",
        stripePriceId: "price_123",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        status: "active" as Stripe.Subscription.Status,
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      });

      await fragment.services.deleteSubscription(created);

      const result = await fragment.services.getSubscriptionById(created);

      expect(result).toBeNull();
    });
  });

  describe("deleteSubscriptionsByReferenceId", () => {
    const testingSub = {
      stripePriceId: "price_123",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      status: "active" as Stripe.Subscription.Status,
      periodStart: new Date(),
      periodEnd: new Date(),
      trialStart: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      seats: 1,
    };

    test("should delete subscription by reference ID", async () => {
      await fragment.services.createSubscription({
        ...testingSub,
        referenceId: "user_ref_delete_123",
      });

      const { success } =
        await fragment.services.deleteSubscriptionsByReferenceId("user_ref_delete_123");
      expect(success).toBe(true);

      const result = await fragment.services.getSubscriptionsByReferenceId("user_ref_delete_123");

      expect(result).toEqual([]);
    });

    test("should delete all subscriptions for one reference ID", async () => {
      const referenceId = "user_ref_delete_123";
      await fragment.services.createSubscription({
        ...testingSub,
        referenceId,
      });
      await fragment.services.createSubscription({
        ...testingSub,
        referenceId,
        stripeSubscriptionId: "sub_456",
      });
      const { success } = await fragment.services.deleteSubscriptionsByReferenceId(referenceId);
      expect(success).toBe(true);

      const result = await fragment.services.getSubscriptionsByReferenceId(referenceId);

      expect(result).toEqual([]);
    });

    test("should return true when deleting non-existent reference ID", async () => {
      const { success } =
        await fragment.services.deleteSubscriptionsByReferenceId("user_nonexistent_ref");
      expect(success).toBe(true);
    });
  });

  describe("getAllSubscriptions", () => {
    test("should retrieve all subscriptions", async () => {
      await fragment.services.createSubscription({
        referenceId: "user_1",
        stripePriceId: "price_1",
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
        status: "active" as Stripe.Subscription.Status,
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      });

      await fragment.services.createSubscription({
        referenceId: "user_2",
        stripePriceId: "price_2",
        stripeCustomerId: "cus_2",
        stripeSubscriptionId: "sub_2",
        status: "trialing" as Stripe.Subscription.Status,
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 2,
      });

      const results = await fragment.services.getAllSubscriptions();

      expect(results).toHaveLength(2);
      expect(results[0].referenceId).toBe("user_1");
      expect(results[1].referenceId).toBe("user_2");
    });

    test("should return empty array when no subscriptions exist", async () => {
      const results = await fragment.services.getAllSubscriptions();

      expect(results).toEqual([]);
    });
  });

  describe("getStripeClient", () => {
    test("should return Stripe client instance", () => {
      const stripeClient = fragment.services.getStripeClient();

      expect(stripeClient).toBeDefined();
    });
  });
});
