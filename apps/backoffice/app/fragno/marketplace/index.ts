import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { marketplaceFragmentDefinition } from "./definition";
import { marketplaceRoutes } from "./routes";

export const createMarketplaceFragment = (options: FragnoPublicConfigWithDatabase) =>
  instantiate(marketplaceFragmentDefinition)
    .withConfig({})
    .withRoutes([marketplaceRoutes])
    .withOptions(options)
    .build();

export type MarketplaceFragment = ReturnType<typeof createMarketplaceFragment>;
