import { test, describe, expect, beforeEach, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { stripeFragmentDefinition } from "../definition";
import { instantiate } from "@fragno-dev/core";

import {
  customerSubscriptionUpdatedHandler,
  customerSubscriptionDeletedHandler,
  checkoutSessionCompletedHandler,
  eventToHandler,
  type SupportedStripeEvent,
} from "../webhook/handlers";

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
});

/* Importing the Stripe type breaks tsc, as a workaround I copied a smaller version of the type here. */
type ShallowStripeEvent = {
  id: string;
  type: string;
  object: string;
  api_version: string | null;
  created: number;
  livemode: boolean;
  pending_webhooks: number;
  request: {
    id: string | null;
    idempotency_key: string | null;
  } | null;
  data: {
    object: {
      id: string;
      subscription: string;
      status: string;
    };
  };
};

function getEventJson(eventName: string, variant?: string): ShallowStripeEvent {
  const eventPath = variant
    ? path.join(__dirname, `./test-events/${eventName}_${variant}.json`)
    : path.join(__dirname, `./test-events/${eventName}.json`);

  const eventJson = fs.readFileSync(eventPath, "utf8");
  const event = JSON.parse(eventJson);
  if (event.type !== eventName) {
    throw new Error(`Event type mismatch: expected ${eventName}, got ${event.type}`);
  }
  return event;
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
  // Mock resolveEntityFromRequest callback
  const mockResolveEntityFromRequest = vi.fn().mockResolvedValue({
    referenceId: "test_user",
    stripeCustomerId: "cus_test",
    customerEmail: "test@example.com",
    subscriptionId: undefined,
    stripeMetadata: {},
  });

  const config = {
    stripeSecretKey: "sk_test_mock_key",
    webhookSecret: "whsec_test_mock_secret",
    enableAdminRoutes: true,
    resolveEntityFromRequest: mockResolveEntityFromRequest,
    onStripeCustomerCreated: vi.fn(),
  };

  // Create fragment with test configuration
  const { fragments } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment("stripe", instantiate(stripeFragmentDefinition).withConfig(config))
    .build();

  const fragment = fragments.stripe;

  beforeEach(() => {
    mockSubscriptionsRetrieve.mockClear();
  });

  // CUSTOMER
  describe.sequential("customer.subscription.updated", () => {
    const event = getEventJson("customer.subscription.updated");

    test("creates new subscription if missing", async () => {
      await customerSubscriptionUpdatedHandler({
        // @ts-expect-error TS2322
        event: event,
        services: fragment.services,
        deps: fragment.deps,
        config,
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
        // @ts-expect-error TS2322
        event: updatedEvent,
        services: fragment.services,
        deps: fragment.deps,
        config,
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
        // @ts-expect-error TS2322
        event: event,
        services: fragment.services,
        deps: fragment.deps,
        config,
      });
      // Still not there
      subscription = await fragment.services.getSubscriptionByStripeId(event.data.object.id);
      expect(subscription).toBeNull();
    });

    test("deletes existing subscription", async () => {
      let subscription = await fragment.services.getSubscriptionByStripeId(event.data.object.id);
      expect(subscription).toBeDefined();

      await customerSubscriptionDeletedHandler({
        // @ts-expect-error TS2322
        event: event,
        services: fragment.services,
        deps: fragment.deps,
        config,
      });

      subscription = await fragment.services.getSubscriptionByStripeId(event.data.object.id);
      expect(subscription).toBeNull();
    });
  });

  describe("customer.subscription", async () => {
    // These events are handled by the same handler and update only a few simple fields
    // TODO: missing is 'resumed', 'pending_update_applied' and 'pending_update_expired' event files
    for (const subEvent of ["created", "paused", "trial_will_end"]) {
      test(subEvent + " updates status", async () => {
        const eventName = `customer.subscription.${subEvent}`;
        const event = getEventJson(eventName);
        const handler = eventToHandler[eventName as SupportedStripeEvent];
        await handler({
          // @ts-expect-error TS2322
          event: event,
          services: fragment.services,
          deps: fragment.deps,
          config,
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
        // @ts-expect-error TS2322
        event: event,
        services: fragment.services,
        deps: fragment.deps,
        config,
      });
      expect(true);
    });

    test("Creates subscription from checkout session", async () => {
      const event = getEventJson("checkout.session.completed", "subscription");
      await checkoutSessionCompletedHandler({
        // @ts-expect-error TS2322
        event: event,
        services: fragment.services,
        deps: fragment.deps,
        config,
      });

      const subscription = await fragment.services.getSubscriptionByStripeId(
        event.data.object.subscription,
      );
      expect(subscription).toBeDefined();
      expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(event.data.object.subscription);
    });
  });
});
