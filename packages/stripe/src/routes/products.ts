import { z } from "zod";
import { ProductResponseSchema } from "../models/products";
import { defineRoutes } from "@fragno-dev/core/api/route";
import { stripeFragmentDefinition } from "../definition";

export const productsRoutesFactory = defineRoutes(stripeFragmentDefinition).create(
  ({ deps, config, defineRoute }) => {
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
  },
);
