import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import type { StripeFragmentConfig, StripeFragmentDeps, StripeFragmentServices } from "../types";
import { CustomerSchema } from "../models/customers";

export const customersRoutesFactory = defineRoutes<
  StripeFragmentConfig,
  StripeFragmentDeps,
  StripeFragmentServices
>().create(({ deps }) => {
  return [
    defineRoute({
      method: "GET",
      path: "/customers",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(10)
          .describe("Number of customers to return (max 100)"),
        startingAfter: z.string().optional().describe("Customer ID to start after for pagination"),
      }),
      outputSchema: z.object({
        customers: z.array(CustomerSchema),
        hasMore: z.boolean().describe("Whether there are more customers to fetch"),
      }),
      errorCodes: ["CUSTOMERS_FETCH_FAILED"] as const,
      handler: async ({ query }, { json, error }) => {
        try {
          const limit = Number(query.get("limit")) || undefined;
          const startingAfter = query.get("startingAfter") || undefined;

          const customers = await deps.stripe.customers.list({
            limit,
            starting_after: startingAfter,
          });

          return json({
            customers: customers.data.map((customer) => ({
              id: customer.id,
              email: customer.email,
              name: customer.name ?? null,
              created: customer.created,
              metadata: customer.metadata,
            })),
            hasMore: customers.has_more,
          });
        } catch (err) {
          console.error("Failed to fetch customers:", err);
          return error(
            {
              message: `Failed to fetch customers: ${err instanceof Error ? err.message : "Unknown error"}`,
              code: "CUSTOMERS_FETCH_FAILED",
            },
            500,
          );
        }
      },
    }),
  ];
});
