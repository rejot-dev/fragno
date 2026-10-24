import type Stripe from "stripe";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { stripeFragmentDefinition } from "../definition";
import { stripeId } from "../subscriptions";
import { invalidQueryMessage, stripeListParams, stripeListQueryParameters } from "./stripe-lists";

const priceSchema = z.object({
  id: z.string(),
  product: z.string(),
  active: z.boolean(),
  currency: z.string(),
  unit_amount: z.number().nullable().describe("In the currency's smallest unit"),
  type: z.string().describe("one_time or recurring"),
  recurring: z
    .object({
      interval: z.string().describe("day, week, month or year"),
      interval_count: z.number(),
    })
    .nullable(),
  nickname: z.string().nullable(),
  lookup_key: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  created: z.number().describe("Unix time in seconds"),
});

function priceFromStripe(price: Stripe.Price): z.infer<typeof priceSchema> {
  return {
    id: price.id,
    product: stripeId(price.product),
    active: price.active,
    currency: price.currency,
    unit_amount: price.unit_amount,
    type: price.type,
    recurring: price.recurring && {
      interval: price.recurring.interval,
      interval_count: price.recurring.interval_count,
    },
    nickname: price.nickname,
    lookup_key: price.lookup_key,
    metadata: price.metadata,
    created: price.created,
  };
}

export const pricesRoutesFactory = defineRoutes(stripeFragmentDefinition).create(
  ({ deps, defineRoute }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/admin/products/:productId/prices",
        queryParameters: stripeListQueryParameters,
        outputSchema: z.object({
          prices: z.array(priceSchema),
          hasMore: z.boolean().describe("Whether there are more items to fetch"),
        }),
        errorCodes: ["INVALID_QUERY"] as const,
        handler: async ({ pathParams, query }, { json, error }) => {
          const params = stripeListParams(query);
          if (!params) {
            return error({ message: invalidQueryMessage, code: "INVALID_QUERY" }, 400);
          }
          const prices = await deps.stripe.prices.list({
            ...params,
            product: pathParams.productId,
          });
          return json({
            prices: prices.data.map(priceFromStripe),
            hasMore: prices.has_more,
          });
        },
      }),
    ];
  },
);
