import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import type { StripeFragmentConfig, StripeFragmentDeps, StripeFragmentServices } from "../types";
import { ProductResponseSchema } from "../models/products";

export const productsRoutesFactory = defineRoutes<
  StripeFragmentConfig,
  StripeFragmentDeps,
  StripeFragmentServices
>().create(({ deps, config }) => {
  return [
    defineRoute({
      method: "GET",
      path: "/admin/products",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(50)
          .describe("Number of products to return (max 100)"),
        startingAfter: z.string().optional().describe("Product ID to start after for pagination"),
      }),
      outputSchema: z.object({
        products: z.array(ProductResponseSchema),
        hasMore: z.boolean().describe("Whether there are more items to fetch"),
      }),
      handler: async ({ query }, { json, error }) => {
        if (!config.enableAdminRoutes) {
          return error({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
        }

        const limit = Number(query.get("limit")) || undefined;
        const startingAfter = query.get("startingAfter") || undefined;

        const products = await deps.stripe.products.list({
          limit,
          starting_after: startingAfter,
        });

        return json({
          products: products.data,
          hasMore: products.has_more,
        });
      },
    }),
  ];
});
