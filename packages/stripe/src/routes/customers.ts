import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import type { StripeFragmentConfig, StripeFragmentDeps, StripeFragmentServices } from "../types";
import { CustomerResponseSchema } from "../models/customers";

export const customersRoutesFactory = defineRoutes<
  StripeFragmentConfig,
  StripeFragmentDeps,
  StripeFragmentServices
>().create(({ deps, config }) => {
  return [
    defineRoute({
      method: "GET",
      path: "/admin/customers",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(50)
          .describe("Number of customers to return (max 100)"),
        startingAfter: z.string().optional().describe("Customer ID to start after for pagination"),
      }),
      outputSchema: z.object({
        customers: z.array(CustomerResponseSchema),
        hasMore: z.boolean().describe("Whether there are more customers to fetch"),
      }),
      handler: async ({ query, headers }, { json, error }) => {
        const limit = Number(query.get("limit")) || undefined;
        const startingAfter = query.get("startingAfter") || undefined;

        const user = await config.authMiddleware.getUserData(headers);
        if (!user || !user.isAdmin) {
          return error({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
        }

        const customers = await deps.stripe.customers.list({
          limit,
          starting_after: startingAfter,
        });
        return json({
          customers: customers.data,
          hasMore: customers.has_more,
        });
      },
    }),
  ];
});
