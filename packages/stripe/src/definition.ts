import type { TableToColumnValues } from "@fragno-dev/db/query";
import Stripe from "stripe";

import { defineFragment } from "@fragno-dev/core";
import {
  defaultDurableHookRetryPolicy,
  withDatabase,
  type DurableHookRetryPolicy,
  type HookContext,
  type HookFn,
  type TypedUnitOfWork,
} from "@fragno-dev/db";

import { stripeSchema } from "./schema";
import {
  reportedSubscription,
  rowMatchesRecord,
  stripeId,
  subscriptionFromRow,
  type ReportedSubscription,
} from "./subscriptions";
import type { StripeCustomerLink, StripeFragmentConfig } from "./types";

/** The Stripe API version the fragment's types and record mapping are written against. */
const STRIPE_API_VERSION = "2026-09-30.endive";

export type StripeHooksMap = {
  processStripeEvent: HookFn<{ event: Stripe.Event }>;
  deliverStripeEvent: HookFn<{ event: Stripe.Event }>;
  syncCustomerSubscriptions: HookFn<{ customerId: string }>;
  onCustomerLinked: HookFn<StripeCustomerLink>;
  onSubscriptionChanged: HookFn<{ subscriptionId: string }>;
};

type StripeUow = TypedUnitOfWork<typeof stripeSchema, unknown[], unknown, StripeHooksMap>;

export type LinkCustomerResult =
  | { ok: true }
  | { ok: false; code: "REFERENCE_ALREADY_LINKED" | "CUSTOMER_ALREADY_LINKED" };

/** Records a new link; the caller has checked that neither side is linked yet. */
export function recordCustomerLink(uow: StripeUow, link: StripeCustomerLink) {
  uow.checkAbsent("customer", "primary", { id: link.customerId });
  uow.checkAbsent("customer", "idx_customer_reference_id", { referenceId: link.referenceId });
  uow.create("customer", { id: link.customerId, referenceId: link.referenceId });
  uow.triggerHook("onCustomerLinked", link);
  // A customer that existed before the link may already have subscriptions, synced without it.
  uow.triggerHook("syncCustomerSubscriptions", { customerId: link.customerId });
}

/** The subscription a Stripe event is about, if any. */
function subscriptionIdOfEvent(event: Stripe.Event): string | null {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    return session.mode === "subscription" && session.subscription
      ? stripeId(session.subscription)
      : null;
  }
  if (event.type.startsWith("customer.subscription.")) {
    return (event.data.object as Stripe.Subscription).id;
  }
  return null;
}

type SubscriptionRow = TableToColumnValues<typeof stripeSchema.tables.subscription>;
type CustomerRow = TableToColumnValues<typeof stripeSchema.tables.customer>;

/**
 * Writes subscriptions as Stripe reported them. `rows` holds the stored rows among them and
 * `customers` the links of their customers.
 */
function recordSubscriptions(
  uow: StripeUow,
  reported: ReportedSubscription[],
  rows: SubscriptionRow[],
  customers: CustomerRow[],
) {
  const rowsById = new Map(rows.map((row) => [row.id.externalId, row]));
  const referenceIdsByCustomer = new Map(
    customers.map((customer) => [customer.id.externalId, customer.referenceId]),
  );

  for (const { record, customerReferenceId } of reported) {
    const row = rowsById.get(record.id);
    // The link decides; before a customer is linked, its metadata names the entity. A deleted
    // customer has neither, and its subscriptions stay with the entity they belonged to.
    const referenceId =
      referenceIdsByCustomer.get(record.customerId) ??
      customerReferenceId ??
      row?.referenceId ??
      null;
    if (row && rowMatchesRecord(row, record, referenceId)) {
      continue;
    }

    const { id, ...columns } = record;
    if (row) {
      uow.update("subscription", row.id, (b) =>
        b.set({ ...columns, referenceId, updatedAt: b.now() }).check(),
      );
    } else {
      uow.checkAbsent("subscription", "primary", { id });
      uow.create("subscription", { id, ...columns, referenceId });
    }
    uow.triggerHook("onSubscriptionChanged", { subscriptionId: id });
  }
}

async function syncSubscriptions(
  handlerTx: HookContext["handlerTx"],
  stripeSubscriptions: Stripe.Subscription[],
) {
  const reported = stripeSubscriptions.map(reportedSubscription);
  const subscriptionIds = reported.map(({ record }) => record.id);
  const customerIds = [...new Set(reported.map(({ record }) => record.customerId))];

  await handlerTx()
    .retrieve(({ forSchema }) =>
      forSchema(stripeSchema)
        .find("subscription", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "in", subscriptionIds)),
        )
        .find("customer", (b) => b.whereIndex("primary", (eb) => eb("id", "in", customerIds))),
    )
    .mutate(({ forSchema, retrieveResult: [rows, customers] }) => {
      recordSubscriptions(
        forSchema<typeof stripeSchema, StripeHooksMap>(stripeSchema),
        reported,
        rows,
        customers,
      );
    })
    .execute();
}

function listCustomerSubscriptions(stripe: Stripe, customerId: string) {
  return stripe.subscriptions
    .list({ customer: customerId, status: "all", limit: 100, expand: ["data.customer"] })
    .autoPagingToArray({ limit: 10_000 });
}

/** Stripe rejected the request itself, e.g. for an unknown object; asking again gets the same answer. */
const stripeRetryPolicy: DurableHookRetryPolicy = {
  ...defaultDurableHookRetryPolicy,
  isRetryable: (error) => !(error instanceof Stripe.errors.StripeInvalidRequestError),
};

export const stripeFragmentDefinition = defineFragment<StripeFragmentConfig>("stripe")
  .extend(withDatabase(stripeSchema))
  .withDependencies(({ config }) => ({
    stripe: new Stripe(config.stripeSecretKey, {
      apiVersion: STRIPE_API_VERSION,
      httpClient: Stripe.createFetchHttpClient(config.fetch),
    }),
  }))
  .provideHooks<StripeHooksMap>(({ defineHook, deps, config }) => ({
    processStripeEvent: defineHook(
      async function ({ event }) {
        if (event.type === "customer.deleted") {
          const customerId = event.data.object.id;
          await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(stripeSchema).findFirst("customer", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", customerId)),
              ),
            )
            .mutate(({ forSchema, retrieveResult: [customer] }) => {
              if (customer) {
                forSchema(stripeSchema).delete("customer", customer.id);
              }
            })
            .execute();
          return;
        }

        const subscriptionId = subscriptionIdOfEvent(event);
        if (!subscriptionId) {
          return;
        }
        // Events arrive in any order and repeat, so an event prompts a sync of the subscription as
        // Stripe reports it now instead of applying the event's snapshot.
        const subscription = await deps.stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["customer"],
        });
        await syncSubscriptions(this.handlerTx.bind(this), [subscription]);
      },
      { retryPolicy: stripeRetryPolicy },
    ),

    deliverStripeEvent: defineHook(async function (payload) {
      await config.onStripeEvent?.(payload, this);
    }),

    syncCustomerSubscriptions: defineHook(
      async function ({ customerId }) {
        const subscriptions = await listCustomerSubscriptions(deps.stripe, customerId);
        if (subscriptions.length > 0) {
          await syncSubscriptions(this.handlerTx.bind(this), subscriptions);
        }
      },
      { retryPolicy: stripeRetryPolicy },
    ),

    onCustomerLinked: defineHook(async function (payload) {
      await config.onCustomerLinked?.(payload, this);
    }),

    onSubscriptionChanged: defineHook(async function ({ subscriptionId }) {
      if (!config.onSubscriptionChanged) {
        return;
      }
      const subscription = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(stripeSchema).findFirst("subscription", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", subscriptionId)),
          ),
        )
        .transformRetrieve(([row]) => {
          // Subscriptions are never deleted, so the row that triggered this hook still exists.
          if (!row) {
            throw new Error(`Subscription ${subscriptionId} is missing.`);
          }
          return subscriptionFromRow(row);
        })
        .execute();
      await config.onSubscriptionChanged({ subscription }, this);
    }),
  }))
  .providesBaseService(({ defineService, deps }) =>
    defineService({
      getCustomerByReferenceId(referenceId: string) {
        return this.serviceTx(stripeSchema)
          .retrieve((uow) =>
            uow.findFirst("customer", (b) =>
              b.whereIndex("idx_customer_reference_id", (eb) =>
                eb("referenceId", "=", referenceId),
              ),
            ),
          )
          .transformRetrieve(
            ([customer]): StripeCustomerLink | null =>
              customer && { customerId: customer.id.externalId, referenceId: customer.referenceId },
          )
          .build();
      },

      getSubscriptionsByReferenceId(referenceId: string) {
        return this.serviceTx(stripeSchema)
          .retrieve((uow) =>
            uow.find("subscription", (b) =>
              b.whereIndex("idx_subscription_reference_id", (eb) =>
                eb("referenceId", "=", referenceId),
              ),
            ),
          )
          .transformRetrieve(([subscriptions]) => subscriptions.map(subscriptionFromRow))
          .build();
      },

      /**
       * Syncs the entity's subscriptions from Stripe now, for when the app cannot wait for webhooks,
       * e.g. on the page Stripe Checkout returns to.
       */
      syncSubscriptions(referenceId: string) {
        return this.serviceTx(stripeSchema)
          .retrieve((uow) =>
            uow
              .findFirst("customer", (b) =>
                b.whereIndex("idx_customer_reference_id", (eb) =>
                  eb("referenceId", "=", referenceId),
                ),
              )
              .find("subscription", (b) =>
                b.whereIndex("idx_subscription_reference_id", (eb) =>
                  eb("referenceId", "=", referenceId),
                ),
              ),
          )
          .transformRetrieve(async ([customer, rows]) => ({
            customer,
            rows,
            reported: customer
              ? (await listCustomerSubscriptions(deps.stripe, customer.id.externalId)).map(
                  reportedSubscription,
                )
              : [],
          }))
          .mutate(({ uow, retrieveResult: { customer, rows, reported } }) => {
            // Rows of a linked customer are owned by its entity, so `rows` holds all of them.
            if (customer) {
              recordSubscriptions(uow, reported, rows, [customer]);
            }
          })
          .build();
      },

      /**
       * Links an existing Stripe customer to an app entity, e.g. to import links an app stored
       * itself. The customer's subscriptions are synced afterwards.
       */
      linkCustomer(link: StripeCustomerLink) {
        return this.serviceTx(stripeSchema)
          .retrieve((uow) =>
            uow
              .findFirst("customer", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", link.customerId)),
              )
              .findFirst("customer", (b) =>
                b.whereIndex("idx_customer_reference_id", (eb) =>
                  eb("referenceId", "=", link.referenceId),
                ),
              )
              .find("subscription", (b) =>
                b.whereIndex("idx_subscription_customer_id", (eb) =>
                  eb("customerId", "=", link.customerId),
                ),
              ),
          )
          .mutate(
            ({
              uow,
              retrieveResult: [byCustomer, byReference, subscriptions],
            }): LinkCustomerResult => {
              if (byCustomer && byCustomer.referenceId === link.referenceId) {
                return { ok: true };
              }
              if (byReference) {
                return { ok: false, code: "REFERENCE_ALREADY_LINKED" };
              }
              if (byCustomer) {
                return { ok: false, code: "CUSTOMER_ALREADY_LINKED" };
              }
              recordCustomerLink(uow, link);
              // Subscriptions synced before the link may belong to no entity or another one.
              for (const subscription of subscriptions) {
                if (subscription.referenceId !== link.referenceId) {
                  uow.update("subscription", subscription.id, (b) =>
                    b.set({ referenceId: link.referenceId, updatedAt: b.now() }).check(),
                  );
                  uow.triggerHook("onSubscriptionChanged", {
                    subscriptionId: subscription.id.externalId,
                  });
                }
              }
              return { ok: true };
            },
          )
          .build();
      },
    }),
  )
  .build();
