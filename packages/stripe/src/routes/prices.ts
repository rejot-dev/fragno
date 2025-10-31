import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import type { StripeFragmentConfig, StripeFragmentDeps, StripeFragmentServices } from "../types";
import { PriceResponseSchema } from "../models/prices";

export const pricesRoutesFactory = defineRoutes<
  StripeFragmentConfig,
  StripeFragmentDeps,
  StripeFragmentServices
>().create(({ deps }) => {
  return [
    defineRoute({
      method: "GET",
      path: "/admin/products/:productId/prices",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(50)
          .describe("Number of prices to return (max 100)"),
        startingAfter: z.string().optional().describe("Price ID to start after for pagination"),
      }),
      outputSchema: z.object({
        prices: z.array(PriceResponseSchema),
        hasMore: z.boolean().describe("Whether there are more items to fetch"),
      }),
      handler: async ({ pathParams, query }, { json }) => {
        const { productId } = pathParams;
        const limit = Number(query.get("limit")) || undefined;
        const startingAfter = query.get("startingAfter") || undefined;

        const prices = await deps.stripe.prices.list({
          product: productId,
          limit,
          starting_after: startingAfter,
        });

        return json({
          prices: prices.data,
          hasMore: prices.has_more,
        });
      },
    }),
  ];
});
