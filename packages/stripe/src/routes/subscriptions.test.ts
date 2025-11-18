import { test, describe, expect, beforeEach, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { stripeFragmentDefinition } from "../definition";
import { subscriptionsRoutesFactory } from "./subscriptions";
import { instantiate } from "@fragno-dev/core";
import type Stripe from "stripe";

// Mock Stripe client methods
const mockCustomersSearch = vi.fn();
const mockCustomersCreate = vi.fn();
const mockCheckoutSessionsCreate = vi.fn();
const mockSubscriptionsRetrieve = vi.fn();
const mockBillingPortalSessionsCreate = vi.fn();
const mockOnStripeCustomerCreated = vi.fn();

// Mock resolveEntityFromRequest function - can be configured per test
const mockResolveEntityFromRequest = vi.fn();

// Mock the Stripe module
vi.mock("stripe", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      customers: {
        search: mockCustomersSearch,
        create: mockCustomersCreate,
      },
      checkout: {
        sessions: {
          create: mockCheckoutSessionsCreate,
        },
      },
      subscriptions: {
        retrieve: mockSubscriptionsRetrieve,
      },
      billingPortal: {
        sessions: {
          create: mockBillingPortalSessionsCreate,
        },
      },
    })),
  };
});

describe("subscription handlers", async () => {
  const { fragments } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "stripe",
      instantiate(stripeFragmentDefinition)
        .withConfig({
          stripeSecretKey: "sk_test_mock_key",
          webhookSecret: "whsec_test_mock_secret",
          enableAdminRoutes: true,
          resolveEntityFromRequest: mockResolveEntityFromRequest,
          onStripeCustomerCreated: mockOnStripeCustomerCreated,
        })
        .withRoutes([subscriptionsRoutesFactory]),
    )
    .build();

  const fragment = fragments.stripe;

  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();

    // Set default resolveEntityFromRequest response
    mockResolveEntityFromRequest.mockResolvedValue({
      referenceId: "test_user",
      stripeCustomerId: undefined,
      customerEmail: "test@example.com",
      subscriptionId: undefined,
      stripeMetadata: {},
    });
  });

  describe.sequential("GET /subscriptions", () => {
    test("should return empty array when no subscriptions exist", async () => {
      const response = await fragment.callRoute("GET", "/admin/subscriptions");

      expect(response.type).toBe("json");
      if (response.type === "json") {
        expect(response.data).toEqual({ subscriptions: [] });
      }
    });

    test("should return all subscriptions after creating one", async () => {
      // Create test subscription
      await fragment.services.createSubscription({
        referenceId: "user_1",
        stripePriceId: "price_1",
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
        status: "active",
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      });

      const response = await fragment.callRoute("GET", "/admin/subscriptions");

      expect(response.type).toBe("json");
      if (response.type === "json") {
        expect(response.data.subscriptions.length).toBeGreaterThanOrEqual(1);
        const sub = response.data.subscriptions.find((s) => s.referenceId === "user_1");
        expect(sub).toBeDefined();
        expect(sub?.stripeCustomerId).toBe("cus_1");
      }
    });
  });

  describe("POST /subscription/upgrade", () => {
    test("should create new subscription without existing stripe customer", async () => {
      // Mock auth middleware to return user without Stripe customer
      mockResolveEntityFromRequest.mockResolvedValue({
        referenceId: "user_123",
        stripeCustomerId: undefined,
        customerEmail: "user@example.com",
        subscriptionId: undefined,
        stripeMetadata: {},
      });

      // Mock: No existing customer found
      mockCustomersSearch.mockResolvedValue({
        data: [],
      });

      // Mock: Create new customer
      mockCustomersCreate.mockResolvedValue({
        id: "cus_new_123",
        email: "user@example.com",
      } as Stripe.Customer);

      // Mock: Create checkout session
      mockCheckoutSessionsCreate.mockResolvedValue({
        id: "cs_123",
        url: "https://checkout.stripe.com/pay/cs_123",
      } as Stripe.Checkout.Session);

      const response = await fragment.callRoute("POST", "/subscription/upgrade", {
        body: {
          priceId: "price_123",
          quantity: 1,
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        },
      });

      expect(response.type).toBe("json");
      if (response.type === "json") {
        expect(response.data).toEqual({
          url: "https://checkout.stripe.com/pay/cs_123",
          redirect: true,
          sessionId: "cs_123",
        });
      }

      // Verify Stripe methods were called
      expect(mockCustomersSearch).toHaveBeenCalledWith({
        query: "metadata['referenceId']:'user_123'",
        limit: 1,
      });
      expect(mockCustomersCreate).toHaveBeenCalledWith({
        email: "user@example.com",
        metadata: {
          referenceId: "user_123",
        },
      });
      expect(mockCheckoutSessionsCreate).toHaveBeenCalled();
      expect(mockOnStripeCustomerCreated).toHaveBeenCalledWith("cus_new_123", "user_123");
    });

    test("should create new subscription with existing linked stripe customer", async () => {
      // Mock auth middleware to return user without Stripe customer
      mockResolveEntityFromRequest.mockResolvedValue({
        referenceId: "user_123",
        stripeCustomerId: undefined,
        customerEmail: undefined,
        subscriptionId: undefined,
        stripeMetadata: {},
      });

      // Mock: Existing customer found
      mockCustomersSearch.mockResolvedValue({
        data: [
          {
            id: "cus_existing_123",
            email: "user@example.com",
            metadata: {
              referenceId: "user_123",
            },
          },
        ],
      });

      // Mock: Create checkout session
      mockCheckoutSessionsCreate.mockResolvedValue({
        id: "cs_123",
        url: "https://checkout.stripe.com/pay/cs_123",
      } as Stripe.Checkout.Session);

      const response = await fragment.callRoute("POST", "/subscription/upgrade", {
        body: {
          priceId: "price_123",
          quantity: 1,
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        },
      });

      expect(response.type).toBe("json");
      if (response.type === "json") {
        expect(response.data).toEqual({
          url: "https://checkout.stripe.com/pay/cs_123",
          redirect: true,
          sessionId: "cs_123",
        });
      }
      expect(mockCheckoutSessionsCreate).toHaveBeenCalled();
      expect(mockOnStripeCustomerCreated).toHaveBeenCalledWith("cus_existing_123", "user_123");
    });

    test("should return error when missing customer info", async () => {
      // Mock auth middleware to return user without customer email
      mockResolveEntityFromRequest.mockResolvedValue({
        referenceId: "user_123",
        stripeCustomerId: undefined,
        customerEmail: undefined, // Missing customer email
        subscriptionId: undefined,
        stripeMetadata: {},
      });

      // Mock: No existing customer found
      mockCustomersSearch.mockResolvedValue({
        data: [],
      });

      const response = await fragment.callRoute("POST", "/subscription/upgrade", {
        body: {
          priceId: "price_123",
          quantity: 1,
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        },
      });

      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.code).toBe("MISSING_CUSTOMER_INFO");
        expect(response.status).toBe(500);
      }
    });

    test("should upgrade existing active subscription using billing portal", async () => {
      // Create existing subscription
      const subscription = await fragment.services.createSubscription({
        referenceId: "user_123",
        stripePriceId: "price_old",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        status: "active",
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      });

      // Mock auth middleware to return user with existing subscription
      mockResolveEntityFromRequest.mockResolvedValue({
        referenceId: "user_123",
        stripeCustomerId: "cus_123",
        customerEmail: "user@example.com",
        subscriptionId: subscription,
        stripeMetadata: {},
      });

      // Mock: Retrieve subscription from Stripe
      mockSubscriptionsRetrieve.mockResolvedValue({
        id: "sub_123",
        items: {
          data: [{ id: "si_123", price: "price_old", quantity: 1 }],
        },
      } as unknown as Stripe.Subscription);

      // Mock: Create billing portal session
      mockBillingPortalSessionsCreate.mockResolvedValue({
        url: "https://billing.stripe.com/portal",
      } as Stripe.BillingPortal.Session);

      const response = await fragment.callRoute("POST", "/subscription/upgrade", {
        body: {
          priceId: "price_new",
          quantity: 2,
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        },
      });

      expect(response.type).toBe("json");
      if (response.type === "json") {
        expect(response.data).toEqual({
          url: "https://billing.stripe.com/portal",
          redirect: true,
        });
      }

      expect(mockBillingPortalSessionsCreate).toHaveBeenCalled();
    });

    test("should return error for non-existent subscription", async () => {
      // Mock auth middleware to return user with non-existent subscription
      mockResolveEntityFromRequest.mockResolvedValue({
        referenceId: "user_123",
        stripeCustomerId: "this_customer_does_not_exist",
        customerEmail: "user@example.com",
        stripeMetadata: {},
      });

      const response = await fragment.callRoute("POST", "/subscription/upgrade", {
        body: {
          priceId: "price_123",
          quantity: 1,
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        },
      });

      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.code).toBe("NO_ACTIVE_SUBSCRIPTIONS");
        expect(response.status).toBe(400);
      }
    });
  });

  describe("POST /subscription/cancel", () => {
    test("should cancel active subscription", async () => {
      // Create active subscription
      await fragment.services.createSubscription({
        referenceId: "user_123",
        stripePriceId: "price_123",
        stripeCustomerId: "cust_active_1",
        stripeSubscriptionId: "sub_123",
        status: "active",
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      });

      // Mock auth middleware to return user with active subscription
      mockResolveEntityFromRequest.mockResolvedValue({
        referenceId: "user_123",
        stripeCustomerId: "cust_active_1",
        customerEmail: "user@example.com",
        stripeMetadata: {},
      });

      // Mock: Retrieve subscription from Stripe
      mockSubscriptionsRetrieve.mockResolvedValue({
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
      } as Stripe.Subscription);

      // Mock: Create billing portal session for cancellation
      mockBillingPortalSessionsCreate.mockResolvedValue({
        url: "https://billing.stripe.com/cancel",
      } as Stripe.BillingPortal.Session);

      const response = await fragment.callRoute("POST", "/subscription/cancel", {
        body: {
          returnUrl: "https://example.com/return",
        },
      });

      expect(response.type).toBe("json");
      if (response.type === "json") {
        expect(response.data).toEqual({
          url: "https://billing.stripe.com/cancel",
          redirect: true,
        });
      }

      expect(mockBillingPortalSessionsCreate).toHaveBeenCalledWith({
        customer: "cust_active_1",
        return_url: "https://example.com/return",
        flow_data: expect.objectContaining({
          type: "subscription_cancel",
        }),
      });
    });

    test("should return error when subscription not found", async () => {
      // Mock auth middleware to return user with non-existent subscription
      mockResolveEntityFromRequest.mockResolvedValue({
        referenceId: "user_123",
        stripeCustomerId: "this_customer_does_not_exist",
        customerEmail: "user@example.com",
        stripeMetadata: {},
      });

      const response = await fragment.callRoute("POST", "/subscription/cancel", {
        body: {
          returnUrl: "https://example.com/return",
        },
      });

      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.code).toBe("NO_SUBSCRIPTION_TO_CANCEL");
        expect(response.status).toBe(404);
      }
    });

    test("should return error when subscription already canceled", async () => {
      // Create canceled subscription
      await fragment.services.createSubscription({
        referenceId: "user_123",
        stripePriceId: "price_123",
        stripeCustomerId: "cus_of_cancelled_sub",
        stripeSubscriptionId: "sub_123",
        status: "canceled",
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: true,
        cancelAt: new Date(),
        seats: 1,
      });

      // Mock auth middleware to return user with canceled subscription
      mockResolveEntityFromRequest.mockResolvedValue({
        referenceId: "user_123",
        stripeCustomerId: "cus_of_cancelled_sub",
        customerEmail: "user@example.com",
        stripeMetadata: {},
      });

      const response = await fragment.callRoute("POST", "/subscription/cancel", {
        body: {
          returnUrl: "https://example.com/return",
        },
      });

      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.code).toBe("NO_SUBSCRIPTION_TO_CANCEL");
        expect(response.status).toBe(404);
      }
    });

    test("should handle multiple active subscriptions", async () => {
      const subscriptionData = {
        referenceId: "user_123",
        stripePriceId: "price_123",
        stripeCustomerId: "customer_of_multiple_subscriptions",
        stripeSubscriptionId: "sub_123",
        status: "active",
        periodStart: new Date(),
        periodEnd: new Date(),
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        seats: 1,
      };
      const sub1 = await fragment.services.createSubscription(subscriptionData);
      const _sub2 = await fragment.services.createSubscription({
        ...subscriptionData,
        stripeSubscriptionId: "sub_456",
      });

      mockResolveEntityFromRequest.mockResolvedValue({
        referenceId: "user_123",
        stripeCustomerId: "customer_of_multiple_subscriptions",
        customerEmail: "user@example.com",
        stripeMetadata: {},
      });

      const response = await fragment.callRoute("POST", "/subscription/cancel", {
        body: {
          returnUrl: "https://example.com/return",
        },
      });

      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.code).toBe("MULTIPLE_SUBSCRIPTIONS_FOUND");
        expect(response.status).toBe(400);
      }

      const response2 = await fragment.callRoute("POST", "/subscription/cancel", {
        body: {
          returnUrl: "https://example.com/return",
          subscriptionId: sub1,
        },
      });

      expect(response2.type).toBe("json");
      if (response2.type === "json") {
        expect(response2.data).toEqual({
          url: "https://billing.stripe.com/cancel",
          redirect: true,
        });
      }
    });
  });
});
