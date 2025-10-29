import { test, describe, expect, beforeEach, vi } from "vitest";
import { createDatabaseFragmentForTest } from "@fragno-dev/test";
import { stripeFragmentDefinition } from "..";
import type { AuthMiddleware } from "../types";

import {
  customerSubscriptionUpdatedHandler,
  customerSubscriptionDeletedHandler,
  checkoutSessionCompletedHandler,
  eventToHandler,
} from "../webhook/handlers";
import type Stripe from "stripe";
import path from "path";

import fs from "fs";

// Mock Stripe client
const mockSubscriptionsRetrieve = vi.fn().mockResolvedValue({
  id: "sub_1SNG2WQmJc11Jgb4zLbJsGVN",
  customer: "cus_TJtp6DFEx6WP2M",
  status: "active",
  items: {
    data: [
      {
        price: "price_test_123",
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 2592000, // +30 days
        quantity: 1,
      },
    ],
  },
  trial_start: null,
  trial_end: null,
  cancel_at: null,
  cancel_at_period_end: false,
} as Stripe.Subscription);

function getEventJson(eventName: string, variant?: string): Stripe.Event {
  const eventPath = variant
    ? path.join(__dirname, `./test-events/${eventName}_${variant}.json`)
    : path.join(__dirname, `./test-events/${eventName}.json`);

  const eventJson = fs.readFileSync(eventPath, "utf8");
  const event = JSON.parse(eventJson);
  if (event.type !== eventName) {
    throw new Error(`Event type mismatch: expected ${eventName}, got ${event.type}`);
  }
  return event as Stripe.Event;
}

// Mock the Stripe module
vi.mock("stripe", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      subscriptions: {
        retrieve: mockSubscriptionsRetrieve,
      },
    })),
  };
});

describe("webhooks", async () => {
  // Mock auth middleware
  const mockAuthMiddleware: AuthMiddleware = {
    getUserData: vi.fn().mockResolvedValue({
      referenceId: "test_user",
      stripeCustomerId: "cus_test",
      customerEmail: "test@example.com",
      subscriptionId: undefined,
      stripeMetadata: {},
      isAdmin: true,
    }),
  };

  // Create fragment with test configuration
  const fragment = await createDatabaseFragmentForTest(stripeFragmentDefinition, [], {
    config: {
      stripeSecretKey: "sk_test_mock_key",
      webhookSecret: "whsec_test_mock_secret",
      subscriptions: {
        enabled: true,
      },
      authMiddleware: mockAuthMiddleware,
      onStripeCustomerCreated: vi.fn(),
    },
    {
      adapter: { type: "kysely-sqlite" },
    },
  );

  beforeEach(() => {
    mockSubscriptionsRetrieve.mockClear();
  });

  // CUSTOMER
  describe.sequential("customer.subscription.updated", () => {
    const event = getEventJson("customer.subscription.updated");

    test("creates new subscription if missing", async () => {
      await customerSubscriptionUpdatedHandler({
        event: event as unknown as Stripe.Event,
        services: fragment.services,
        deps: fragment.deps,
        config: fragment.config,
      });

      const subscription = await fragment.services.getAllSubscriptions();
      expect(subscription).toHaveLength(1);
      expect(subscription[0].status).toBe("active");
    });

    test("updates existing subscription", async () => {
      let subscriptions = await fragment.services.getAllSubscriptions();
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].status).toBe("active");

      const updatedEvent = {
        ...event,
        data: {
          ...event.data,
          object: {
            ...event.data!.object,
            status: "inactive" as const,
          },
        },
      };

      await customerSubscriptionUpdatedHandler({
        event: updatedEvent as unknown as Stripe.Event,
        services: fragment.services,
        deps: fragment.deps,
        config: fragment.config,
      });

      subscriptions = await fragment.services.getAllSubscriptions();
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].status).toBe("inactive");
    });
  });

  describe.sequential("customer.subscription.deleted", () => {
    const event = getEventJson("customer.subscription.deleted");

    test("ignores event if no existing subscription", async () => {
      let subscription = await fragment.services.getSubscriptionByStripeId(event.data.object.id);
      expect(subscription).toBeNull();

      await customerSubscriptionDeletedHandler({
        event: event as unknown as Stripe.Event,
        services: fragment.services,
        deps: fragment.deps,
        config: fragment.config,
      });
      // Still not there
      subscription = await fragment.services.getSubscriptionByStripeId(event.data.object.id);
      expect(subscription).toBeNull();
    });

    test("deletes existing subscription", async () => {
      let subscription = await fragment.services.getSubscriptionByStripeId(event.data.object.id);
      expect(subscription).toBeDefined();

      await customerSubscriptionDeletedHandler({
        event: event as unknown as Stripe.Event,
        services: fragment.services,
        deps: fragment.deps,
        config: fragment.config,
      });

      subscription = await fragment.services.getSubscriptionByStripeId(event.data.object.id);
      expect(subscription).toBeNull();
    });
  });

  describe("customer.subscription", async () => {
    // These events are handled by the same handler and update only a few simple fields
    // TODO: missing is 'resumed', 'pending_update_applied' and 'pending_update_expired' event files
    for (const subEvent of ["paused", "trial_will_end"]) {
      test(subEvent + " updates status", async () => {
        const eventName = `customer.subscription.${subEvent}`;
        const event = getEventJson(eventName);
        const handler = eventToHandler[eventName];
        await handler({
          event: event as unknown as Stripe.Event,
          services: fragment.services,
          deps: fragment.deps,
          config: fragment.config,
        });

        const subscription = await fragment.services.getSubscriptionByStripeId(
          event.data.object.id,
        );
        expect(subscription).toBeDefined();
        expect(subscription?.status).toBe(event.data.object.status);
      });
    }
  });

  // CHECKOUT
  describe("checkout.session.completed", async () => {
    test("ignores non-subscription checkout sessions", async () => {
      const event = getEventJson("checkout.session.completed", "payment");
      await checkoutSessionCompletedHandler({
        event: event as unknown as Stripe.Event,
        services: fragment.services,
        deps: fragment.deps,
        config: fragment.config,
      });
      expect(true);
    });

    test("Creates subscription from checkout session", async () => {
      const event = getEventJson("checkout.session.completed", "subscription");
      await checkoutSessionCompletedHandler({
        event: event as unknown as Stripe.Event,
        services: fragment.services,
        deps: fragment.deps,
        config: fragment.config,
      });

      const subscription = await fragment.services.getSubscriptionByStripeId(
        event.data.object.subscription,
      );
      expect(subscription).toBeDefined();
      expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(event.data.object.subscription);
    });
  });
});
