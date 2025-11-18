import { z } from "zod";
import { CustomerResponseSchema } from "../models/customers";
import { stripeToApiError } from "./errors";
import { defineRoutes } from "@fragno-dev/core";
import { stripeFragmentDefinition } from "../definition";

export const customersRoutesFactory = defineRoutes(stripeFragmentDefinition).create(
  ({ deps, config, defineRoute }) => {
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
          startingAfter: z
            .string()
            .optional()
            .describe("Customer ID to start after for pagination"),
        }),
        outputSchema: z.object({
          customers: z.array(CustomerResponseSchema),
          hasMore: z.boolean().describe("Whether there are more customers to fetch"),
        }),
        handler: async ({ query }, { json, error }) => {
          if (!config.enableAdminRoutes) {
            return error({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
          }

          const limit = Number(query.get("limit")) || undefined;
          const startingAfter = query.get("startingAfter") || undefined;

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
      defineRoute({
        method: "POST",
        path: "/portal",
        inputSchema: z.object({
          returnUrl: z.url().describe("URL to redirect to after completing billing portal"),
        }),
        outputSchema: z.object({
          url: z.url().describe("URL to redirect to after cancellation"),
          redirect: z.boolean().describe("Whether to redirect to the URL"),
        }),
        errorCodes: ["NO_STRIPE_CUSTOMER_FOR_ENTITY"] as const,
        handler: async (context, { json, error }) => {
          const body = await context.input.valid();
          const { stripeCustomerId } = await config.resolveEntityFromRequest(context);

          if (!stripeCustomerId) {
            return error(
              {
                message: "No stripe customer to create billing portal for",
                code: "NO_STRIPE_CUSTOMER_FOR_ENTITY",
              },
              400,
            );
          }

          try {
            const portalSession = await deps.stripe.billingPortal.sessions.create({
              customer: stripeCustomerId,
              return_url: body.returnUrl,
            });

            return json({
              url: portalSession.url,
              redirect: true,
            });
          } catch (err: unknown) {
            throw stripeToApiError(err);
          }
        },
      }),
    ];
  },
);
