import Stripe from "stripe";
import type { TableToColumnValues, TableToInsertValues } from "@fragno-dev/db/query";
import type {
  Logger,
  StripeFragmentConfig,
  StripeFragmentDeps,
  StripeFragmentServices,
} from "./types";
import { stripeSchema } from "./database/schema";
import type { SubscriptionResponse } from "./models/subscriptions";
import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type DatabaseServiceContext } from "@fragno-dev/db";
import { stripeSubscriptionToInternalSubscription } from "./utils";

const LOG_PREFIX = "[Stripe Fragment]";
const defaultLogger: Logger = {
  info: (...data) => console.info(LOG_PREFIX, ...data),
  error: (...data) => console.error(LOG_PREFIX, ...data),
  warn: (...data) => console.warn(LOG_PREFIX, ...data),
  debug: (...data) => console.debug(LOG_PREFIX, ...data),
  log: (...data) => console.log(LOG_PREFIX, ...data),
};

type SubscriptionRow = TableToColumnValues<typeof stripeSchema.tables.subscription>;

const asExternalSubscription = (subscription: SubscriptionRow): SubscriptionResponse => ({
  id: subscription.id.externalId,
  referenceId: subscription.referenceId,
  stripePriceId: subscription.stripePriceId,
  stripeCustomerId: subscription.stripeCustomerId,
  stripeSubscriptionId: subscription.stripeSubscriptionId,
  status: subscription.status as Stripe.Subscription.Status,
  periodStart: subscription.periodStart,
  periodEnd: subscription.periodEnd,
  trialStart: subscription.trialStart,
  trialEnd: subscription.trialEnd,
  cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
  cancelAt: subscription.cancelAt,
  seats: subscription.seats,
  createdAt: subscription.createdAt,
  updatedAt: subscription.updatedAt,
});

function createStripeServices(
  deps: StripeFragmentDeps,
  defineService: <T>(svc: T & ThisType<DatabaseServiceContext<{}>>) => T,
): StripeFragmentServices {
  return defineService({
    getStripeClient(): Stripe {
      return deps.stripe;
    },
    createSubscription(
      data: Omit<
        TableToInsertValues<typeof stripeSchema.tables.subscription>,
        "id" | "createdAt" | "updatedAt"
      >,
    ) {
      return this.serviceTx(stripeSchema)
        .mutate(({ uow }) => {
          const created = uow.create("subscription", data);
          return created.externalId;
        })
        .build();
    },
    updateSubscription(
      id: string,
      data: Partial<Omit<TableToInsertValues<typeof stripeSchema.tables.subscription>, "id">>,
    ) {
      return this.serviceTx(stripeSchema)
        .mutate(({ uow }) =>
          uow.update("subscription", id, (b) => b.set({ ...data, updatedAt: new Date() })),
        )
        .build();
    },

    getSubscriptionByStripeId(stripeSubscriptionId: string) {
      return this.serviceTx(stripeSchema)
        .retrieve((uow) =>
          uow.findFirst("subscription", (b) =>
            b.whereIndex("idx_stripe_subscription_id", (eb) =>
              eb("stripeSubscriptionId", "=", stripeSubscriptionId),
            ),
          ),
        )
        .transformRetrieve(([result]) => (result ? asExternalSubscription(result) : null))
        .build();
    },
    getSubscriptionsByStripeCustomerId(stripeCustomerId: string) {
      return this.serviceTx(stripeSchema)
        .retrieve((uow) =>
          uow.find("subscription", (b) =>
            b.whereIndex("idx_stripe_customer_id", (eb) =>
              eb("stripeCustomerId", "=", stripeCustomerId),
            ),
          ),
        )
        .transformRetrieve(([result]) => result.map(asExternalSubscription))
        .build();
    },
    getSubscriptionById(id: string) {
      return this.serviceTx(stripeSchema)
        .retrieve((uow) =>
          uow.findFirst("subscription", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id))),
        )
        .transformRetrieve(([result]) => (result ? asExternalSubscription(result) : null))
        .build();
    },
    getSubscriptionsByReferenceId(referenceId: string) {
      return this.serviceTx(stripeSchema)
        .retrieve((uow) =>
          uow.find("subscription", (b) =>
            b.whereIndex("idx_reference_id", (eb) => eb("referenceId", "=", referenceId)),
          ),
        )
        .transformRetrieve(([result]) => result.map(asExternalSubscription))
        .build();
    },

    deleteSubscription(id: string) {
      return this.serviceTx(stripeSchema)
        .mutate(({ uow }) => uow.delete("subscription", id))
        .build();
    },

    deleteSubscriptionsByReferenceId(referenceId: string) {
      return this.serviceTx(stripeSchema)
        .retrieve((uow) =>
          uow.find("subscription", (b) =>
            b.whereIndex("idx_reference_id", (eb) => eb("referenceId", "=", referenceId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [subscriptions] }) => {
          subscriptions.forEach((sub) => {
            uow.delete("subscription", sub.id);
          });
          return { success: true };
        })
        .build();
    },

    getAllSubscriptions() {
      return this.serviceTx(stripeSchema)
        .retrieve((uow) => uow.find("subscription", (b) => b.whereIndex("primary")))
        .transformRetrieve(([result]) => result.map(asExternalSubscription))
        .build();
    },

    /* Create/update/delete internal entity based on provided Stripe subscriptions. */
    syncStripeSubscriptions(
      referenceId: string,
      _stripeCustomerId: string,
      stripeSubscriptions: Stripe.Subscription[],
    ) {
      if (stripeSubscriptions.length === 0) {
        return this.serviceTx(stripeSchema)
          .retrieve((uow) =>
            uow.find("subscription", (b) =>
              b.whereIndex("idx_reference_id", (eb) => eb("referenceId", "=", referenceId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [subscriptions] }) => {
            subscriptions.forEach((sub) => {
              uow.delete("subscription", sub.id);
            });
            return { success: true };
          })
          .build();
      }

      return this.serviceTx(stripeSchema)
        .retrieve((uow) =>
          uow.find("subscription", (b) =>
            b.whereIndex("idx_reference_id", (eb) => eb("referenceId", "=", referenceId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existingSubscriptions] }) => {
          for (const stripeSubscription of stripeSubscriptions) {
            const existingSubscription = existingSubscriptions.find(
              (sub) => sub.stripeSubscriptionId === stripeSubscription.id,
            );

            if (existingSubscription) {
              uow.update("subscription", existingSubscription.id, (b) =>
                b
                  .set({
                    ...stripeSubscriptionToInternalSubscription(stripeSubscription),
                    updatedAt: new Date(),
                  })
                  .check(),
              );
            } else {
              uow.create("subscription", {
                ...stripeSubscriptionToInternalSubscription(stripeSubscription),
                referenceId: referenceId ?? null,
                updatedAt: new Date(),
              });
            }
          }

          return { success: true };
        })
        .build();
    },
  });
}

export const stripeFragmentDefinition = defineFragment<StripeFragmentConfig>("stripe")
  .extend(withDatabase(stripeSchema))
  .withDependencies(({ config }) => {
    const stripeClient = new Stripe(config.stripeSecretKey, config.stripeClientOptions ?? {});

    return {
      stripe: stripeClient,
      log: config.logger ? config.logger : defaultLogger,
    };
  })
  .providesBaseService(({ deps, defineService }) => createStripeServices(deps, defineService))
  .build();
