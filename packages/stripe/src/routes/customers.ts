import type Stripe from "stripe";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { stripeFragmentDefinition } from "../definition";
import { stripeToApiError } from "./errors";
import { invalidQueryMessage, stripeListParams, stripeListQueryParameters } from "./stripe-lists";

const customerSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  created: z.number().describe("Unix time in seconds"),
});

function customerFromStripe(customer: Stripe.Customer): z.infer<typeof customerSchema> {
  return {
    id: customer.id,
    email: customer.email,
    name: customer.name ?? null,
    description: customer.description,
    metadata: customer.metadata,
    created: customer.created,
  };
}

export const customersRoutesFactory = defineRoutes(stripeFragmentDefinition).create(
  ({ deps, services, config, defineRoute }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/admin/customers",
        queryParameters: stripeListQueryParameters,
        outputSchema: z.object({
          customers: z.array(customerSchema),
          hasMore: z.boolean().describe("Whether there are more customers to fetch"),
        }),
        errorCodes: ["INVALID_QUERY"] as const,
        handler: async ({ query }, { json, error }) => {
          const params = stripeListParams(query);
          if (!params) {
            return error({ message: invalidQueryMessage, code: "INVALID_QUERY" }, 400);
          }
          const customers = await deps.stripe.customers.list(params);
          return json({
            customers: customers.data.map(customerFromStripe),
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
        outputSchema: z.object({ url: z.url().describe("URL of the billing portal") }),
        errorCodes: ["UNAUTHENTICATED", "NO_STRIPE_CUSTOMER_FOR_ENTITY"] as const,
        handler: async function (context, { json, error }) {
          const body = await context.input.valid();
          const entity = await config.resolveEntityFromRequest(context);
          if (!entity) {
            return error({ message: "Not authenticated", code: "UNAUTHENTICATED" }, 401);
          }

          let url: string | null;
          try {
            url = await this.handlerTx()
              .withServiceCalls(
                () => [services.getCustomerByReferenceId(entity.referenceId)] as const,
              )
              .transformRetrieve(async (_, [customer]) => {
                if (!customer) {
                  return null;
                }
                const portalSession = await deps.stripe.billingPortal.sessions.create({
                  customer: customer.customerId,
                  return_url: body.returnUrl,
                });
                return portalSession.url;
              })
              .execute();
          } catch (err) {
            throw stripeToApiError(err);
          }

          if (!url) {
            return error(
              {
                message: "No Stripe customer to create billing portal for",
                code: "NO_STRIPE_CUSTOMER_FOR_ENTITY",
              },
              400,
            );
          }
          return json({ url });
        },
      }),
    ];
  },
);
