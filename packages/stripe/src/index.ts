import type { FragnoPublicClientConfig } from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import type { StripeFragmentConfig } from "./types";
import { stripeFragmentDefinition } from "./definition";
import { webhookRoutesFactory } from "./routes/webhooks";
import { customersRoutesFactory } from "./routes/customers";
import { subscriptionsRoutesFactory } from "./routes/subscriptions";
import { productsRoutesFactory } from "./routes/products";
import { pricesRoutesFactory } from "./routes/prices";
import { instantiate } from "@fragno-dev/core/api/fragment-instantiator";

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
    // These hooks are for building internal administrative interfaces
    useCustomers: builder.createHook("/admin/customers"),
    useProducts: builder.createHook("/admin/products"),
    usePrices: builder.createHook("/admin/products/:productId/prices"),
    useSubscription: builder.createHook("/admin/subscriptions"),
    // Billing Portal for stripe customer
    useBillingPortal: builder.createMutator("POST", "/portal"),
    // These clients are for end-users to create/update/cancel their subscriptions
    upgradeSubscription: builder.createMutator("POST", "/subscription/upgrade"),
    cancelSubscription: builder.createMutator("POST", "/subscription/cancel"),
  };
}

export { stripeFragmentDefinition } from "./definition";
export type {
  StripeFragmentConfig,
  StripeFragmentDeps,
  StripeFragmentServices,
  Logger,
} from "./types";
export type { FragnoRouteConfig } from "@fragno-dev/core/api";
