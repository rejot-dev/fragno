import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { marketplaceFragmentDefinition } from "./definition";
import { marketplaceRoutes } from "./routes";

export const createMarketplaceFragment = (options: FragnoPublicConfigWithDatabase) =>
  instantiate(marketplaceFragmentDefinition)
    .withConfig({})
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
      return isPublic
        ? undefined
        : Response.json(
            {
              code: "FRAGMENT_ROUTE_NOT_EXPOSED",
              message: "Marketplace HTTP exposes published listings only.",
            },
            { status: 404 },
          );
    });

export type MarketplaceFragment = ReturnType<typeof createMarketplaceFragment>;
