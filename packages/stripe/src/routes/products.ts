import type Stripe from "stripe";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { stripeFragmentDefinition } from "../definition";
import { stripeId } from "../subscriptions";
import { invalidQueryMessage, stripeListParams, stripeListQueryParameters } from "./stripe-lists";

const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
  default_price: z.string().nullable(),
  images: z.array(z.string()),
  metadata: z.record(z.string(), z.string()),
  created: z.number().describe("Unix time in seconds"),
});

function productFromStripe(product: Stripe.Product): z.infer<typeof productSchema> {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    active: product.active,
    default_price: product.default_price ? stripeId(product.default_price) : null,
    images: product.images,
    metadata: product.metadata,
    created: product.created,
  };
}

export const productsRoutesFactory = defineRoutes(stripeFragmentDefinition).create(
  ({ deps, defineRoute }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/admin/products",
        queryParameters: stripeListQueryParameters,
        outputSchema: z.object({
          products: z.array(productSchema),
          hasMore: z.boolean().describe("Whether there are more items to fetch"),
        }),
        errorCodes: ["INVALID_QUERY"] as const,
        handler: async ({ query }, { json, error }) => {
          const params = stripeListParams(query);
          if (!params) {
            return error({ message: invalidQueryMessage, code: "INVALID_QUERY" }, 400);
          }
          const products = await deps.stripe.products.list(params);
          return json({
            products: products.data.map(productFromStripe),
            hasMore: products.has_more,
          });
        },
      }),
    ];
  },
);
