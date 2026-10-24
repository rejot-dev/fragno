import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { stripeFragmentDefinition } from "./definition";
import { customersRoutesFactory } from "./routes/customers";
import { pricesRoutesFactory } from "./routes/prices";
import { productsRoutesFactory } from "./routes/products";
import { subscriptionsRoutesFactory } from "./routes/subscriptions";
import { webhookRoutesFactory } from "./routes/webhooks";
import type { StripeFragmentConfig } from "./types";

const routes = [
  webhookRoutesFactory,
  customersRoutesFactory,
  subscriptionsRoutesFactory,
  productsRoutesFactory,
  pricesRoutesFactory,
] as const;

export function createStripeFragment(
  config: StripeFragmentConfig,
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  return instantiate(stripeFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();
}

export function createStripeFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(stripeFragmentDefinition, fragnoConfig, routes);

  return {
    // Admin hooks for internal interfaces; gate `/admin/*` routes with middleware.
    useCustomers: builder.createHook("/admin/customers"),
    useProducts: builder.createHook("/admin/products"),
    usePrices: builder.createHook("/admin/products/:productId/prices"),
    useSubscriptions: builder.createHook("/admin/subscriptions"),
    // Mutators for the authenticated entity.
    useBillingPortal: builder.createMutator("POST", "/portal"),
    upgradeSubscription: builder.createMutator("POST", "/subscription/upgrade"),
    cancelSubscription: builder.createMutator("POST", "/subscription/cancel"),
  };
}

export { stripeFragmentDefinition, type LinkCustomerResult } from "./definition";
export type { Subscription, SubscriptionStatus } from "./subscriptions";
export type {
  StripeCustomerLink,
  StripeEntity,
  StripeFragmentConfig,
  StripeRequestContext,
} from "./types";
export type { FragnoRouteConfig } from "@fragno-dev/core";
