import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { marketplaceFragmentDefinition, type MarketplaceFragmentConfig } from "./definition";
import { marketplaceRoutes } from "./routes";

export const createMarketplaceFragment = (
  config: MarketplaceFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
) =>
  instantiate(marketplaceFragmentDefinition)
    .withConfig(config)
    .withRoutes([marketplaceRoutes])
    .withOptions(options)
    .build()
    .withMiddleware(async function exposePublishedMarketplaceReads({ ifMatchesRoute }) {
      let isPublic = false;
      await ifMatchesRoute("GET", "/listings", () => {
        isPublic = true;
      });
      await ifMatchesRoute("GET", "/listings/:listingId", () => {
        isPublic = true;
      });
      // Organization Marketplaces are members-only, so only System listings are anonymously readable.
      return isPublic && config.scope.kind === "system"
        ? undefined
        : Response.json(
            {
              code: "FRAGMENT_ROUTE_NOT_EXPOSED",
              message: "Marketplace HTTP exposes published public listings only.",
            },
            { status: 404 },
          );
    });

export type MarketplaceFragment = ReturnType<typeof createMarketplaceFragment>;
