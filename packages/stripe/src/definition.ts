import Stripe from "stripe";
import type { SimpleQueryInterface, TableToInsertValues } from "@fragno-dev/db/query";
import type {
  Logger,
  StripeFragmentConfig,
  StripeFragmentDeps,
  StripeFragmentServices,
} from "./types";
import { stripeSchema } from "./database/schema";
import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { stripeSubscriptionToInternalSubscription } from "./utils";

const LOG_PREFIX = "[Stripe Fragment]";
const defaultLogger: Logger = {
  info: (...data) => console.info(LOG_PREFIX, ...data),
  error: (...data) => console.error(LOG_PREFIX, ...data),
  warn: (...data) => console.warn(LOG_PREFIX, ...data),
  debug: (...data) => console.debug(LOG_PREFIX, ...data),
  log: (...data) => console.log(LOG_PREFIX, ...data),
};

const asExternalSubscription = <T extends { id: { externalId: string }; status: string }>(
  subscription: T,
) => ({
  ...subscription,
  id: subscription.id.externalId,
  status: subscription.status as Stripe.Subscription.Status,
});

function createStripeServices(
  deps: StripeFragmentDeps,
  db: SimpleQueryInterface<typeof stripeSchema>,
): StripeFragmentServices {
  const services: StripeFragmentServices = {
    getStripeClient(): Stripe {
      return deps.stripe;
    },
    createSubscription: async (
      data: Omit<
        TableToInsertValues<typeof stripeSchema.tables.subscription>,
        "id" | "createdAt" | "updatedAt"
      >,
    ) => {
      return (await db.create("subscription", data)).externalId;
    },
    updateSubscription: async (
      id: string,
      data: Partial<Omit<TableToInsertValues<typeof stripeSchema.tables.subscription>, "id">>,
    ) => {
      await db.update("subscription", id, (b) => b.set({ ...data, updatedAt: new Date() }));
    },

    getSubscriptionByStripeId: async (stripeSubscriptionId: string) => {
      const result = await db.findFirst("subscription", (b) =>
        b.whereIndex("idx_stripe_subscription_id", (eb) =>
          eb("stripeSubscriptionId", "=", stripeSubscriptionId),
        ),
      );
      if (!result) {
        return null;
      }

      return asExternalSubscription(result);
    },
    getSubscriptionsByStripeCustomerId: async (stripeCustomerId: string) => {
      return (
        await db.find("subscription", (b) =>
          b.whereIndex("idx_stripe_customer_id", (eb) =>
            eb("stripeCustomerId", "=", stripeCustomerId),
          ),
        )
      ).map(asExternalSubscription);
    },
    getSubscriptionById: async (id: string) => {
      const result = await db.findFirst("subscription", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", id)),
      );
      if (!result) {
        return null;
      }
      return asExternalSubscription(result);
    },
    getSubscriptionsByReferenceId: async (referenceId: string) => {
      const result = await db.find("subscription", (b) =>
        b.whereIndex("idx_reference_id", (eb) => eb("referenceId", "=", referenceId)),
      );
      if (result.length == 0) {
        return [];
      }
      return result.map(asExternalSubscription);
    },

    deleteSubscription: async (id: string) => {
      await db.delete("subscription", id);
    },

    deleteSubscriptionsByReferenceId: async (referenceId: string) => {
      const uow = db
        .createUnitOfWork()
        .find("subscription", (b) =>
          b.whereIndex("idx_reference_id", (eb) => eb("referenceId", "=", referenceId)),
        );

      const [subscriptions] = await uow.executeRetrieve();
      subscriptions.forEach((sub) => sub && uow.delete("subscription", sub.id));

      return await uow.executeMutations();
    },

    getAllSubscriptions: async () => {
      return (await db.find("subscription", (b) => b.whereIndex("primary"))).map(
        asExternalSubscription,
      );
    },

    /* Retrieve Stripe Subscription and create/update/delete internal entity */
    syncStripeSubscriptions: async (referenceId: string, stripeCustomerId: string) => {
      const stripeSubscriptions = await deps.stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: "all",
      });

      if (stripeSubscriptions.data.length === 0) {
        await services.deleteSubscriptionsByReferenceId(referenceId);
        return { success: true };
      }

      const uow = db
        .createUnitOfWork()
        .find("subscription", (b) =>
          b.whereIndex("idx_reference_id", (eb) => eb("referenceId", "=", referenceId)),
        );

      const [existingSubscriptions] = await uow.executeRetrieve();

      // Mutation phase: process all Stripe subscriptions (including canceled)
      for (const stripeSubscription of stripeSubscriptions.data) {
        const existingSubscription = existingSubscriptions.find(
          (sub) => sub.stripeSubscriptionId === stripeSubscription.id,
        );

        if (existingSubscription) {
          // Update existing subscription with optimistic concurrency control
          uow.update("subscription", existingSubscription.id, (b) =>
            b
              .set({
                ...stripeSubscriptionToInternalSubscription(stripeSubscription),
                updatedAt: new Date(),
              })
              .check(),
          );
        } else {
          // Create new subscription
          uow.create("subscription", {
            ...stripeSubscriptionToInternalSubscription(stripeSubscription),
            referenceId: referenceId ?? null,
            updatedAt: new Date(),
          });
        }
      }

      // Execute all mutations and return result
      return uow.executeMutations();
    },
  };
  return services;
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
  .providesBaseService(({ deps }) => {
    return {
      ...createStripeServices(deps, deps.db),
    };
  })
  .build();
