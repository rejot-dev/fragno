import { assert, describe, expect, test } from "vitest";

import { buildStripeTest } from "../test-stripe";

async function subscribe(stripeTest: Awaited<ReturnType<typeof buildStripeTest>>, entity: string) {
  stripeTest.signIn(entity);
  const checkout = await stripeTest.upgrade({ priceId: "price_basic" });
  assert(checkout.type === "json");
  return stripeTest.stripe.completeCheckout(checkout.data.url);
}

describe("Stripe webhooks", () => {
  test("a completed checkout becomes the entity's active subscription", async () => {
    const stripeTest = await buildStripeTest();
    const subscriptionId = await subscribe(stripeTest, "user_1");

    await stripeTest.deliver();

    const [customer] = stripeTest.stripe.customers.values();
    expect(await stripeTest.subscriptionsOf("user_1")).toEqual([
      expect.objectContaining({
        id: subscriptionId,
        customerId: customer.id,
        referenceId: "user_1",
        priceId: "price_basic",
        quantity: 1,
        status: "active",
        cancelAtPeriodEnd: false,
      }),
    ]);
    expect(stripeTest.integrator.customerLinks).toEqual([
      { customerId: customer.id, referenceId: "user_1" },
    ]);
    // Both events sync the subscription, but only the first one changes it.
    expect(stripeTest.integrator.subscriptionChanges).toHaveLength(1);
    expect(stripeTest.integrator.stripeEvents.map((event) => event.type)).toEqual([
      "customer.subscription.created",
      "checkout.session.completed",
    ]);

    await stripeTest.cleanup();
  });

  test("events delivered out of order leave the subscription as Stripe reports it", async () => {
    const stripeTest = await buildStripeTest();
    const subscriptionId = await subscribe(stripeTest, "user_1");
    stripeTest.stripe.scheduleCancellation(subscriptionId);
    stripeTest.stripe.endSubscription(subscriptionId);

    // The `created` event, with its active snapshot, arrives last.
    await stripeTest.deliver((events) => events.toReversed());

    expect(await stripeTest.subscriptionsOf("user_1")).toEqual([
      expect.objectContaining({
        id: subscriptionId,
        status: "canceled",
        cancelAtPeriodEnd: true,
        endedAt: expect.any(Date),
      }),
    ]);
    assert(stripeTest.integrator.subscriptionChanges.at(-1)?.status === "canceled");

    await stripeTest.cleanup();
  });

  test("a redelivered event is processed once", async () => {
    const stripeTest = await buildStripeTest();
    await subscribe(stripeTest, "user_1");
    const [created] = stripeTest.stripe.takeEvents();

    const first = await stripeTest.deliverEvent(created);
    const second = await stripeTest.deliverEvent(created);
    await stripeTest.drainHooks();

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(stripeTest.integrator.stripeEvents.map((event) => event.id)).toEqual([created.id]);
    expect(await stripeTest.subscriptionsOf("user_1")).toHaveLength(1);

    await stripeTest.cleanup();
  });

  test("events received while Stripe is down sync once it is back", async () => {
    const stripeTest = await buildStripeTest();
    const subscriptionId = await subscribe(stripeTest, "user_1");

    stripeTest.stripe.available = false;
    await stripeTest.deliver();
    expect(await stripeTest.subscriptionsOf("user_1")).toEqual([]);

    stripeTest.stripe.available = true;
    await stripeTest.retryFailedHooks();

    expect(await stripeTest.subscriptionsOf("user_1")).toEqual([
      expect.objectContaining({ id: subscriptionId, status: "active" }),
    ]);

    await stripeTest.cleanup();
  });

  test("a failing event handler of the app does not hold back the sync", async () => {
    const stripeTest = await buildStripeTest({
      onStripeEvent: async () => {
        throw new Error("The app's handler is broken");
      },
    });
    const subscriptionId = await subscribe(stripeTest, "user_1");

    await stripeTest.deliver();

    expect(stripeTest.integrator.stripeEvents).toEqual([]);
    expect(await stripeTest.subscriptionsOf("user_1")).toEqual([
      expect.objectContaining({ id: subscriptionId, status: "active" }),
    ]);

    await stripeTest.cleanup();
  });

  test("linking a customer assigns the subscriptions it already has", async () => {
    const stripeTest = await buildStripeTest();
    const customerId = stripeTest.stripe.createCustomer({});
    const subscriptionId = stripeTest.stripe.createSubscription(customerId, "price_pro");
    await stripeTest.deliver();
    expect(await stripeTest.subscriptionsOf("user_1")).toEqual([]);

    expect(await stripeTest.linkCustomer({ customerId, referenceId: "user_1" })).toEqual({
      ok: true,
    });

    // The link assigns stored subscriptions at once, before any hook runs.
    const owned = [
      expect.objectContaining({ id: subscriptionId, customerId, priceId: "price_pro" }),
    ];
    expect(await stripeTest.subscriptionsOf("user_1")).toEqual(owned);
    await stripeTest.syncSubscriptions("user_1");
    await stripeTest.drainHooks();
    expect(await stripeTest.subscriptionsOf("user_1")).toEqual(owned);
    expect(await stripeTest.linkCustomer({ customerId, referenceId: "user_2" })).toEqual({
      ok: false,
      code: "CUSTOMER_ALREADY_LINKED",
    });

    await stripeTest.cleanup();
  });

  test("a subscription keeps its entity when its customer's deletion arrives first", async () => {
    const stripeTest = await buildStripeTest();
    const subscriptionId = await subscribe(stripeTest, "user_1");
    await stripeTest.deliver();
    const link = await stripeTest.customerOf("user_1");
    assert(link);

    stripeTest.stripe.deleteCustomer(link.customerId);
    await stripeTest.deliver((events) => events.toReversed());

    expect(await stripeTest.subscriptionsOf("user_1")).toEqual([
      expect.objectContaining({ id: subscriptionId, referenceId: "user_1", status: "canceled" }),
    ]);
    expect(stripeTest.integrator.subscriptionChanges.at(-1)).toMatchObject({
      id: subscriptionId,
      referenceId: "user_1",
      status: "canceled",
    });

    await stripeTest.cleanup();
  });

  test("a deleted customer is unlinked, so the next checkout creates a new one", async () => {
    const stripeTest = await buildStripeTest();
    await subscribe(stripeTest, "user_1");
    await stripeTest.deliver();
    const firstCustomer = await stripeTest.customerOf("user_1");
    assert(firstCustomer);

    stripeTest.stripe.deleteCustomer(firstCustomer.customerId);
    await stripeTest.deliver();
    expect(await stripeTest.customerOf("user_1")).toBeNull();

    const checkout = await stripeTest.upgrade({ priceId: "price_basic" });
    assert(checkout.type === "json");
    const secondCustomer = await stripeTest.customerOf("user_1");
    expect(secondCustomer?.customerId).not.toBe(firstCustomer.customerId);

    await stripeTest.cleanup();
  });
});
