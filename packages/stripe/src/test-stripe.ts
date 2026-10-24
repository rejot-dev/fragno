import Stripe from "stripe";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment, type HookContext } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { stripeFragmentDefinition } from "./definition";
import { customersRoutesFactory } from "./routes/customers";
import { pricesRoutesFactory } from "./routes/prices";
import { productsRoutesFactory } from "./routes/products";
import { subscriptionsRoutesFactory } from "./routes/subscriptions";
import { webhookRoutesFactory } from "./routes/webhooks";
import type { Subscription } from "./subscriptions";
import type { StripeCustomerLink, StripeEntity } from "./types";

const WEBHOOK_SECRET = "whsec_local";

type Params = Record<string, unknown>;

type LocalSubscription = {
  id: string;
  object: "subscription";
  customer: string;
  status: Stripe.Subscription.Status;
  items: {
    object: "list";
    data: {
      id: string;
      object: "subscription_item";
      price: { id: string; object: "price"; product: string };
      quantity: number;
      current_period_start: number;
      current_period_end: number;
    }[];
    has_more: false;
    url: string;
  };
  trial_start: number | null;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  created: number;
  metadata: Record<string, string>;
};

type LocalCheckoutSession = {
  id: string;
  object: "checkout.session";
  mode: "subscription";
  status: "open" | "complete";
  url: string;
  customer: string;
  client_reference_id: string | null;
  subscription: string | null;
  priceId: string;
  quantity: number;
  discounts: { promotion_code: string }[];
  subscriptionMetadata: Record<string, string>;
};

type LocalPortalSession = {
  id: string;
  object: "billing_portal.session";
  customer: string;
  url: string;
  return_url: string;
  flow_data: Params | null;
};

type EventObject = LocalSubscription | LocalCheckoutSession | Stripe.DeletedCustomer;

class LocalStripeError extends Error {
  constructor(
    readonly status: number,
    readonly body: { type: string; message: string; code: string },
  ) {
    super(body.message);
  }
}

/**
 * The part of the Stripe API the fragment uses, kept in memory. Changes queue the events Stripe
 * would send; tests deliver them in the order they choose.
 */
export class LocalStripe {
  readonly customers = new Map<string, Stripe.Customer>();
  readonly subscriptions = new Map<string, LocalSubscription>();
  readonly checkoutSessions = new Map<string, LocalCheckoutSession>();
  readonly portalSessions: LocalPortalSession[] = [];
  /** Events Stripe has emitted and not yet delivered. */
  pendingEvents: Stripe.Event[] = [];
  /** While false, every request fails as if Stripe were down. */
  available = true;

  readonly #prices = new Map<string, { id: string; product: string }>();
  readonly #promotionCodes = new Map<string, string>();
  readonly #customersByIdempotencyKey = new Map<string, Stripe.Customer>();
  #nextId = 1;
  #now = 1_800_000_000;

  addPrice(id: string, product: string) {
    this.#prices.set(id, { id, product });
  }

  addPromotionCode(code: string) {
    const id = this.#id("promo");
    this.#promotionCodes.set(code, id);
    return id;
  }

  /** A customer created outside the fragment, e.g. by an earlier integration. */
  createCustomer(metadata: Record<string, string>) {
    const customer = this.#createCustomer({ email: null, metadata });
    return customer.id;
  }

  /** A subscription created outside the fragment, e.g. in the Stripe dashboard. */
  createSubscription(customerId: string, priceId: string) {
    const subscription = this.#createSubscription(customerId, priceId, 1, {});
    this.#emit("customer.subscription.created", subscription);
    return subscription.id;
  }

  /** The customer pays on the hosted checkout page. */
  completeCheckout(url: string) {
    const session = [...this.checkoutSessions.values()].find((candidate) => candidate.url === url);
    if (session?.status !== "open") {
      throw new Error(`No open checkout session at ${url}`);
    }
    const subscription = this.#createSubscription(
      session.customer,
      session.priceId,
      session.quantity,
      session.subscriptionMetadata,
    );
    session.status = "complete";
    session.subscription = subscription.id;
    this.#emit("customer.subscription.created", subscription);
    this.#emit("checkout.session.completed", session);
    return subscription.id;
  }

  /** The customer confirms a cancellation in the billing portal. */
  scheduleCancellation(subscriptionId: string) {
    this.#updateSubscription(subscriptionId, { cancel_at_period_end: true });
  }

  /** The subscription period ends after a scheduled cancellation, or Stripe cancels at once. */
  endSubscription(subscriptionId: string) {
    const subscription = this.#subscription(subscriptionId);
    subscription.status = "canceled";
    subscription.canceled_at = this.#tick();
    subscription.ended_at = this.#now;
    this.#emit("customer.subscription.deleted", subscription);
  }

  /** Like Stripe, deleting a customer cancels its subscriptions first. */
  deleteCustomer(customerId: string) {
    const customer = this.#customer(customerId);
    for (const subscription of this.subscriptions.values()) {
      if (subscription.customer === customerId && subscription.status !== "canceled") {
        this.endSubscription(subscription.id);
      }
    }
    this.customers.delete(customerId);
    this.#emit("customer.deleted", { id: customer.id, object: "customer", deleted: true });
  }

  takeEvents() {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const params = parseParams(
      method === "GET" ? url.searchParams : new URLSearchParams(String(init?.body ?? "")),
    );
    const idempotencyKey = new Headers(init?.headers).get("idempotency-key");

    try {
      if (!this.available) {
        throw new LocalStripeError(500, {
          type: "api_error",
          message: "Stripe is unavailable",
          code: "unavailable",
        });
      }
      return jsonResponse(200, this.#handle(method, url.pathname, params, idempotencyKey));
    } catch (error) {
      if (error instanceof LocalStripeError) {
        return jsonResponse(error.status, { error: error.body });
      }
      throw error;
    }
  };

  #handle(method: string, path: string, params: Params, idempotencyKey: string | null): unknown {
    const route = `${method} ${path}`;
    let match: RegExpMatchArray | null;

    if (route === "GET /v1/customers/search") {
      const referenceId = /^metadata\['referenceId'\]:'(.*)'$/.exec(String(params["query"]))?.[1];
      return searchResult(
        [...this.customers.values()].filter(
          (customer) => customer.metadata["referenceId"] === referenceId,
        ),
      );
    }
    if (route === "POST /v1/customers") {
      const replayed = idempotencyKey && this.#customersByIdempotencyKey.get(idempotencyKey);
      if (replayed) {
        return replayed;
      }
      const customer = this.#createCustomer({
        email: String(params["email"]),
        metadata: params["metadata"] as Record<string, string>,
      });
      if (idempotencyKey) {
        this.#customersByIdempotencyKey.set(idempotencyKey, customer);
      }
      return customer;
    }
    if (route === "GET /v1/customers") {
      return list([...this.customers.values()]);
    }
    if (route === "GET /v1/subscriptions") {
      const expand = (params["expand"] as string[] | undefined) ?? [];
      return list(
        [...this.subscriptions.values()]
          .filter(
            (subscription) =>
              subscription.customer === params["customer"] &&
              // Like Stripe, lists leave out canceled subscriptions unless asked for all.
              (params["status"] === "all" || subscription.status !== "canceled"),
          )
          .map((subscription) =>
            expand.includes("data.customer") ? this.#withCustomer(subscription) : subscription,
          ),
      );
    }
    if ((match = /^GET \/v1\/subscriptions\/([^/]+)$/.exec(route))) {
      const subscription = this.#subscription(match[1]);
      const expand = (params["expand"] as string[] | undefined) ?? [];
      return expand.includes("customer") ? this.#withCustomer(subscription) : subscription;
    }
    if ((match = /^POST \/v1\/subscriptions\/([^/]+)$/.exec(route))) {
      return this.#updateSubscription(match[1], {
        cancel_at_period_end: params["cancel_at_period_end"] === "true",
      });
    }
    if (route === "POST /v1/checkout/sessions") {
      const customer = this.#customer(String(params["customer"]));
      const [lineItem] = params["line_items"] as { price: string; quantity: string }[];
      this.#price(lineItem.price);
      const id = this.#id("cs");
      const session: LocalCheckoutSession = {
        id,
        object: "checkout.session",
        mode: "subscription",
        status: "open",
        url: `https://checkout.stripe.test/${id}`,
        customer: customer.id,
        client_reference_id: (params["client_reference_id"] as string | undefined) ?? null,
        subscription: null,
        priceId: lineItem.price,
        quantity: Number(lineItem.quantity),
        discounts: (params["discounts"] as { promotion_code: string }[] | undefined) ?? [],
        subscriptionMetadata:
          ((params["subscription_data"] as Params | undefined)?.["metadata"] as
            | Record<string, string>
            | undefined) ?? {},
      };
      this.checkoutSessions.set(id, session);
      return session;
    }
    if (route === "POST /v1/billing_portal/sessions") {
      const customer = this.#customer(String(params["customer"]));
      const id = this.#id("bps");
      const session: LocalPortalSession = {
        id,
        object: "billing_portal.session",
        customer: customer.id,
        url: `https://billing.stripe.test/${id}`,
        return_url: String(params["return_url"]),
        flow_data: (params["flow_data"] as Params | undefined) ?? null,
      };
      this.portalSessions.push(session);
      return session;
    }
    if (route === "GET /v1/promotion_codes") {
      const id = this.#promotionCodes.get(String(params["code"]));
      return list(id ? [{ id, object: "promotion_code", code: params["code"], active: true }] : []);
    }
    throw new Error(`LocalStripe does not implement ${route}`);
  }

  #createCustomer(input: { email: string | null; metadata: Record<string, string> }) {
    const customer = {
      id: this.#id("cus"),
      object: "customer",
      email: input.email,
      name: null,
      description: null,
      metadata: input.metadata,
      created: this.#tick(),
    } as unknown as Stripe.Customer;
    this.customers.set(customer.id, customer);
    return customer;
  }

  #createSubscription(
    customerId: string,
    priceId: string,
    quantity: number,
    metadata: Record<string, string>,
  ) {
    const price = this.#price(priceId);
    const created = this.#tick();
    const subscription: LocalSubscription = {
      id: this.#id("sub"),
      object: "subscription",
      customer: customerId,
      status: "active",
      items: {
        object: "list",
        data: [
          {
            id: this.#id("si"),
            object: "subscription_item",
            price: { id: price.id, object: "price", product: price.product },
            quantity,
            current_period_start: created,
            current_period_end: created + 30 * 24 * 60 * 60,
          },
        ],
        has_more: false,
        url: "/v1/subscription_items",
      },
      trial_start: null,
      trial_end: null,
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      created,
      metadata,
    };
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  #updateSubscription(subscriptionId: string, changes: { cancel_at_period_end: boolean }) {
    const subscription = this.#subscription(subscriptionId);
    subscription.cancel_at_period_end = changes.cancel_at_period_end;
    subscription.cancel_at = changes.cancel_at_period_end
      ? subscription.items.data[0].current_period_end
      : null;
    subscription.canceled_at = changes.cancel_at_period_end ? this.#tick() : null;
    this.#emit("customer.subscription.updated", subscription);
    return subscription;
  }

  #withCustomer(subscription: LocalSubscription) {
    const customer = this.customers.get(subscription.customer) ?? {
      id: subscription.customer,
      object: "customer",
      deleted: true,
    };
    return { ...subscription, customer };
  }

  #emit(type: string, object: EventObject) {
    this.pendingEvents.push({
      id: this.#id("evt"),
      object: "event",
      type,
      api_version: "2026-09-30.endive",
      created: this.#tick(),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      // Events carry a snapshot of the object as it was when they were emitted.
      data: { object: structuredClone(object) },
    } as unknown as Stripe.Event);
  }

  #customer(id: string) {
    const customer = this.customers.get(id);
    if (!customer) {
      throw missing(`No such customer: '${id}'`);
    }
    return customer;
  }

  #subscription(id: string) {
    const subscription = this.subscriptions.get(id);
    if (!subscription) {
      throw missing(`No such subscription: '${id}'`);
    }
    return subscription;
  }

  #price(id: string) {
    const price = this.#prices.get(id);
    if (!price) {
      throw missing(`No such price: '${id}'`);
    }
    return price;
  }

  #id(prefix: string) {
    return `${prefix}_${String(this.#nextId++).padStart(6, "0")}`;
  }

  #tick() {
    return (this.#now += 60);
  }
}

function missing(message: string) {
  return new LocalStripeError(404, {
    type: "invalid_request_error",
    message,
    code: "resource_missing",
  });
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "request-id": "req_local",
      // Failures surface at once; the durable hooks own retries.
      "stripe-should-retry": "false",
    },
  });
}

function list(data: unknown[]) {
  return { object: "list", data, has_more: false, url: "/v1/list" };
}

function searchResult(data: unknown[]) {
  return { object: "search_result", data, has_more: false, url: "/v1/search", next_page: null };
}

/** Decodes Stripe's form encoding, e.g. `line_items[0][price]=price_1`. */
function parseParams(params: URLSearchParams): Params {
  const root: Params = {};
  for (const [key, value] of params) {
    const path = key.replaceAll("]", "").split("[");
    let node: Params = root;
    for (const [index, segment] of path.entries()) {
      const next = path[index + 1];
      if (next === undefined) {
        node[segment] = value;
      } else {
        node[segment] ??= /^\d+$/.test(next) ? [] : {};
        node = node[segment] as Params;
      }
    }
  }
  return root;
}

export type StripeIntegratorEvents = {
  customerLinks: StripeCustomerLink[];
  subscriptionChanges: Subscription[];
  stripeEvents: Stripe.Event[];
};

/**
 * A Stripe fragment talking to a `LocalStripe`, with the steps an app and its users take.
 * `onStripeEvent` defaults to recording the event; pass a handler to replace it.
 */
export async function buildStripeTest(
  options: {
    onStripeEvent?: (event: Stripe.Event, context: HookContext) => Promise<void>;
  } = {},
) {
  const localStripe = new LocalStripe();
  localStripe.addPrice("price_basic", "prod_basic");
  localStripe.addPrice("price_pro", "prod_pro");

  const integrator: StripeIntegratorEvents = {
    customerLinks: [],
    subscriptionChanges: [],
    stripeEvents: [],
  };
  let signedIn: StripeEntity | null = null;

  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 1 })
    .withFragment(
      "stripe",
      instantiate(stripeFragmentDefinition)
        .withConfig({
          stripeSecretKey: "sk_test_local",
          webhookSecret: WEBHOOK_SECRET,
          fetch: localStripe.fetch,
          resolveEntityFromRequest: async () => signedIn,
          onCustomerLinked: (link) => {
            integrator.customerLinks.push(link);
          },
          onSubscriptionChanged: ({ subscription }) => {
            integrator.subscriptionChanges.push(subscription);
          },
          onStripeEvent: async ({ event }, context) => {
            if (options.onStripeEvent) {
              await options.onStripeEvent(event, context);
            }
            integrator.stripeEvents.push(event);
          },
        })
        .withRoutes([
          webhookRoutesFactory,
          customersRoutesFactory,
          subscriptionsRoutesFactory,
          productsRoutesFactory,
          pricesRoutesFactory,
        ]),
    )
    .build();
  const fragment = fragments.stripe.fragment;
  const signer = new Stripe("sk_test_local");

  async function deliverEvent(event: Stripe.Event) {
    const payload = JSON.stringify(event);
    const signature = await signer.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: WEBHOOK_SECRET,
    });
    return fragment.handler(
      new Request("https://app.test/api/stripe/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body: payload,
      }),
    );
  }

  /** Makes hooks that failed due now instead of after their backoff. */
  async function expireRetryBackoff() {
    const internalFragment = getInternalFragment(test.adapter);
    const hooks = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("stripe")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });
    await internalFragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          for (const hook of hooks) {
            if (hook.status === "pending" && hook.nextRetryAt) {
              forSchema(internalFragment.$internal.deps.schema).update(
                "fragno_hooks",
                hook.id,
                (b) => b.set({ nextRetryAt: new Date(Date.now() - 1_000) }),
              );
            }
          }
        })
        .execute();
    });
  }

  return {
    stripe: localStripe,
    fragment,
    integrator,
    cleanup: () => test.cleanup(),

    signIn(referenceId: string) {
      signedIn = {
        referenceId,
        customerEmail: `${referenceId}@example.com`,
        customerMetadata: { app: "test" },
      };
    },

    upgrade(body: {
      priceId: string;
      quantity?: number;
      promotionCode?: string;
      subscriptionId?: string;
    }) {
      return fragment.callRoute("POST", "/subscription/upgrade", {
        body: {
          quantity: 1,
          successUrl: "https://app.test/billing/success",
          cancelUrl: "https://app.test/billing",
          ...body,
        },
      });
    },

    cancel(body: { subscriptionId?: string } = {}) {
      return fragment.callRoute("POST", "/subscription/cancel", {
        body: { returnUrl: "https://app.test/billing", ...body },
      });
    },

    deliverEvent,

    /** Delivers Stripe's pending events one by one in the order given, each processed in full. */
    async deliver(order: (events: Stripe.Event[]) => Stripe.Event[] = (events) => events) {
      for (const event of order(localStripe.takeEvents())) {
        const response = await deliverEvent(event);
        if (response.status !== 200) {
          throw new Error(`Webhook rejected ${event.type}: ${response.status}`);
        }
        await drainDurableHooks(fragment);
      }
    },

    async retryFailedHooks() {
      await expireRetryBackoff();
      await drainDurableHooks(fragment);
    },

    drainHooks: () => drainDurableHooks(fragment),

    subscriptionsOf(referenceId: string) {
      return fragment.callServices(() =>
        fragment.services.getSubscriptionsByReferenceId(referenceId),
      );
    },

    customerOf(referenceId: string) {
      return fragment.callServices(() => fragment.services.getCustomerByReferenceId(referenceId));
    },

    syncSubscriptions(referenceId: string) {
      return fragment.callServices(() => fragment.services.syncSubscriptions(referenceId));
    },

    linkCustomer(link: StripeCustomerLink) {
      return fragment.callServices(() => fragment.services.linkCustomer(link));
    },
  };
}
