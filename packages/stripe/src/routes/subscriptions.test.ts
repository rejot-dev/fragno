import { assert, describe, expect, test } from "vitest";

import { buildStripeTest } from "../test-stripe";

type StripeTest = Awaited<ReturnType<typeof buildStripeTest>>;

async function subscribe(stripeTest: StripeTest, priceId = "price_basic") {
  const checkout = await stripeTest.upgrade({ priceId });
  assert(checkout.type === "json");
  const subscriptionId = stripeTest.stripe.completeCheckout(checkout.data.url);
  await stripeTest.deliver();
  return subscriptionId;
}

describe("subscription routes", () => {
  test("the first upgrade links a new customer and starts a checkout", async () => {
    const stripeTest = await buildStripeTest();
    stripeTest.signIn("user_1");

    const checkout = await stripeTest.upgrade({ priceId: "price_basic", quantity: 3 });

    assert(checkout.type === "json");
    const [customer] = stripeTest.stripe.customers.values();
    expect(customer).toMatchObject({
      email: "user_1@example.com",
      metadata: { app: "test", referenceId: "user_1" },
    });
    expect(await stripeTest.customerOf("user_1")).toEqual({
      customerId: customer.id,
      referenceId: "user_1",
    });
    const [session] = stripeTest.stripe.checkoutSessions.values();
    expect(session).toMatchObject({
      url: checkout.data.url,
      customer: customer.id,
      client_reference_id: "user_1",
      priceId: "price_basic",
      quantity: 3,
      subscriptionMetadata: { referenceId: "user_1" },
    });

    await stripeTest.cleanup();
  });

  test("the page checkout returns to syncs before the webhook arrives", async () => {
    const stripeTest = await buildStripeTest();
    stripeTest.signIn("user_1");
    const checkout = await stripeTest.upgrade({ priceId: "price_basic" });
    assert(checkout.type === "json");
    const subscriptionId = stripeTest.stripe.completeCheckout(checkout.data.url);

    await stripeTest.syncSubscriptions("user_1");
    await stripeTest.drainHooks();

    expect(await stripeTest.subscriptionsOf("user_1")).toEqual([
      expect.objectContaining({ id: subscriptionId, status: "active" }),
    ]);
    await stripeTest.deliver();
    expect(stripeTest.integrator.subscriptionChanges).toHaveLength(1);

    await stripeTest.cleanup();
  });

  test("an upgrade reuses the customer an earlier integration created", async () => {
    const stripeTest = await buildStripeTest();
    const customerId = stripeTest.stripe.createCustomer({ referenceId: "user_1" });
    stripeTest.signIn("user_1");

    await subscribe(stripeTest);

    assert(stripeTest.stripe.customers.size === 1);
    expect(await stripeTest.customerOf("user_1")).toEqual({ customerId, referenceId: "user_1" });
    expect(await stripeTest.subscriptionsOf("user_1")).toEqual([
      expect.objectContaining({ customerId, status: "active" }),
    ]);

    await stripeTest.cleanup();
  });

  test("an earlier integration's subscription is upgraded in the portal before it is synced", async () => {
    const stripeTest = await buildStripeTest();
    const customerId = stripeTest.stripe.createCustomer({ referenceId: "user_1" });
    const subscriptionId = stripeTest.stripe.createSubscription(customerId, "price_basic");
    stripeTest.signIn("user_1");

    const upgrade = await stripeTest.upgrade({ priceId: "price_pro" });

    assert(upgrade.type === "json");
    expect(upgrade.data.url).toBe(stripeTest.stripe.portalSessions[0]?.url);
    assert(stripeTest.stripe.checkoutSessions.size === 0);
    expect(await stripeTest.customerOf("user_1")).toEqual({ customerId, referenceId: "user_1" });
    await stripeTest.deliver();
    expect(await stripeTest.subscriptionsOf("user_1")).toEqual([
      expect.objectContaining({ id: subscriptionId, referenceId: "user_1" }),
    ]);

    await stripeTest.cleanup();
  });

  test("an upgrade right after linking a customer changes its subscription in the portal", async () => {
    const stripeTest = await buildStripeTest();
    const customerId = stripeTest.stripe.createCustomer({});
    const subscriptionId = stripeTest.stripe.createSubscription(customerId, "price_basic");
    await stripeTest.deliver();
    await stripeTest.linkCustomer({ customerId, referenceId: "user_1" });
    stripeTest.signIn("user_1");

    const upgrade = await stripeTest.upgrade({ priceId: "price_pro" });

    assert(upgrade.type === "json");
    assert(stripeTest.stripe.checkoutSessions.size === 0);
    expect(stripeTest.stripe.portalSessions).toEqual([
      expect.objectContaining({
        url: upgrade.data.url,
        flow_data: expect.objectContaining({
          subscription_update_confirm: expect.objectContaining({ subscription: subscriptionId }),
        }),
      }),
    ]);

    await stripeTest.cleanup();
  });

  test("concurrent first upgrades link one customer", async () => {
    const stripeTest = await buildStripeTest();
    stripeTest.signIn("user_1");

    const checkouts = await Promise.all([
      stripeTest.upgrade({ priceId: "price_basic" }),
      stripeTest.upgrade({ priceId: "price_basic" }),
    ]);

    expect(checkouts.map((checkout) => checkout.type)).toEqual(["json", "json"]);
    const link = await stripeTest.customerOf("user_1");
    assert(link);
    const sessionCustomers = [...stripeTest.stripe.checkoutSessions.values()].map(
      (session) => session.customer,
    );
    expect(new Set(sessionCustomers)).toEqual(new Set([link.customerId]));

    await stripeTest.cleanup();
  });

  test("an active subscription is changed and canceled through the billing portal", async () => {
    const stripeTest = await buildStripeTest();
    stripeTest.signIn("user_1");
    const subscriptionId = await subscribe(stripeTest);
    const [subscription] = await stripeTest.subscriptionsOf("user_1");

    const upgrade = await stripeTest.upgrade({ priceId: "price_pro", quantity: 2 });
    const cancel = await stripeTest.cancel();

    assert(upgrade.type === "json" && cancel.type === "json");
    const [updatePortal, cancelPortal] = stripeTest.stripe.portalSessions;
    expect(upgrade.data.url).toBe(updatePortal.url);
    expect(updatePortal.flow_data).toMatchObject({
      type: "subscription_update_confirm",
      subscription_update_confirm: {
        subscription: subscriptionId,
        items: [{ id: subscription.itemId, price: "price_pro", quantity: "2" }],
      },
    });
    expect(cancel.data.url).toBe(cancelPortal.url);
    expect(cancelPortal.flow_data).toMatchObject({
      type: "subscription_cancel",
      subscription_cancel: { subscription: subscriptionId },
    });

    await stripeTest.cleanup();
  });

  test("upgrading a subscription that is scheduled to cancel resumes it", async () => {
    const stripeTest = await buildStripeTest();
    stripeTest.signIn("user_1");
    const subscriptionId = await subscribe(stripeTest);
    stripeTest.stripe.scheduleCancellation(subscriptionId);
    await stripeTest.deliver();

    const cancelAgain = await stripeTest.cancel();
    assert(cancelAgain.type === "error");
    assert(cancelAgain.error.code === "SUBSCRIPTION_ALREADY_CANCELED");

    const resume = await stripeTest.upgrade({ priceId: "price_basic" });
    assert(resume.type === "json");
    assert(resume.data.url === "https://app.test/billing/success");
    await stripeTest.deliver();

    expect(await stripeTest.subscriptionsOf("user_1")).toEqual([
      expect.objectContaining({ id: subscriptionId, status: "active", cancelAtPeriodEnd: false }),
    ]);

    await stripeTest.cleanup();
  });

  test("an entity whose subscription ended subscribes again through checkout", async () => {
    const stripeTest = await buildStripeTest();
    stripeTest.signIn("user_1");
    const firstSubscriptionId = await subscribe(stripeTest);
    stripeTest.stripe.endSubscription(firstSubscriptionId);
    await stripeTest.deliver();

    const cancel = await stripeTest.cancel();
    assert(cancel.type === "error");
    assert(cancel.error.code === "NO_SUBSCRIPTION_TO_CANCEL");

    const secondSubscriptionId = await subscribe(stripeTest, "price_pro");

    const subscriptions = await stripeTest.subscriptionsOf("user_1");
    expect(subscriptions.map(({ id, status }) => ({ id, status }))).toEqual(
      expect.arrayContaining([
        { id: firstSubscriptionId, status: "canceled" },
        { id: secondSubscriptionId, status: "active" },
      ]),
    );

    await stripeTest.cleanup();
  });

  test("promotion codes apply to checkout and unknown codes are rejected", async () => {
    const stripeTest = await buildStripeTest();
    const promotionCodeId = stripeTest.stripe.addPromotionCode("WELCOME");
    stripeTest.signIn("user_1");

    const unknown = await stripeTest.upgrade({ priceId: "price_basic", promotionCode: "NOPE" });
    const known = await stripeTest.upgrade({ priceId: "price_basic", promotionCode: "WELCOME" });

    assert(unknown.type === "error");
    assert(unknown.error.code === "PROMOTION_CODE_INVALID");
    assert(known.type === "json");
    expect([...stripeTest.stripe.checkoutSessions.values()]).toEqual([
      expect.objectContaining({
        url: known.data.url,
        discounts: [{ promotion_code: promotionCodeId }],
      }),
    ]);

    await stripeTest.cleanup();
  });

  test("admins page through all subscriptions", async () => {
    const stripeTest = await buildStripeTest();
    for (const entity of ["user_1", "user_2", "user_3"]) {
      stripeTest.signIn(entity);
      await subscribe(stripeTest);
    }

    const firstPage = await stripeTest.fragment.callRoute("GET", "/admin/subscriptions", {
      query: { pageSize: "2" },
    });
    assert(firstPage.type === "json" && firstPage.data.cursor);
    const secondPage = await stripeTest.fragment.callRoute("GET", "/admin/subscriptions", {
      query: { pageSize: "2", cursor: firstPage.data.cursor },
    });
    assert(secondPage.type === "json");

    const invalidPages: Record<string, string>[] = [
      { pageSize: "0" },
      { pageSize: "1.5" },
      { cursor: "not-a-cursor" },
    ];
    for (const query of invalidPages) {
      const invalid = await stripeTest.fragment.callRoute("GET", "/admin/subscriptions", { query });
      assert(invalid.type === "error");
      assert(invalid.error.code === "INVALID_QUERY");
    }
    const invalidLists: Record<string, string>[] = [{ limit: "500" }, { startingAfter: "" }];
    for (const query of invalidLists) {
      const invalid = await stripeTest.fragment.callRoute("GET", "/admin/customers", { query });
      assert(invalid.type === "error");
      assert(invalid.error.code === "INVALID_QUERY");
    }

    assert(firstPage.data.hasNextPage);
    assert(!secondPage.data.hasNextPage);
    expect(
      [...firstPage.data.subscriptions, ...secondPage.data.subscriptions].map(
        (subscription) => subscription.referenceId,
      ),
    ).toEqual(["user_1", "user_2", "user_3"]);

    await stripeTest.cleanup();
  });
});
