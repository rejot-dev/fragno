import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import {
  marketplaceCategorySchema,
  marketplaceListingDetailSchema,
  marketplaceListingPageSchema,
  marketplacePublishedListingInputSchema,
} from "./contracts";
import { marketplaceFragmentDefinition } from "./definition";
import { MarketplaceListingCursorError } from "./pagination";

const MARKETPLACE_ROUTE_ERROR_CODES = [
  "MARKETPLACE_INPUT_INVALID",
  "MARKETPLACE_CURSOR_INVALID",
  "MARKETPLACE_LISTING_NOT_FOUND",
] as const;

export const marketplaceRoutes = defineRoutes(marketplaceFragmentDefinition).create(
  ({ defineRoute, services }) => [
    defineRoute({
      method: "GET",
      path: "/listings",
      queryParameters: ["category", "pageSize", "cursor"],
      outputSchema: marketplaceListingPageSchema,
      errorCodes: MARKETPLACE_ROUTE_ERROR_CODES,
      handler: async function ({ query }, { json, error }) {
        const pageSizeValue = query.get("pageSize")?.trim();
        const pageSize = pageSizeValue ? Number(pageSizeValue) : undefined;

        try {
          const category = marketplaceCategorySchema
            .optional()
            .parse(query.get("category")?.trim() || undefined);
          const page = await this.handlerTx()
            .withServiceCalls(() => [
              services.listPublishedListings({
                category,
                pageSize,
                cursor: query.get("cursor")?.trim() || undefined,
              }),
            ])
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          return json(page);
        } catch (cause) {
          if (cause instanceof z.ZodError) {
            return error(
              {
                code: "MARKETPLACE_INPUT_INVALID",
                message: cause.issues[0]?.message ?? cause.message,
              },
              400,
            );
          }
          if (cause instanceof MarketplaceListingCursorError) {
            return error({ code: "MARKETPLACE_CURSOR_INVALID", message: cause.message }, 400);
          }
          throw cause;
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/listings/:listingId",
      queryParameters: ["versionPageSize", "versionCursor"],
      outputSchema: marketplaceListingDetailSchema,
      errorCodes: MARKETPLACE_ROUTE_ERROR_CODES,
      handler: async function ({ pathParams, query }, { json, error }) {
        try {
          const versionPageSizeValue = query.get("versionPageSize")?.trim();
          const input = marketplacePublishedListingInputSchema.parse({
            listingId: pathParams.listingId,
            versionPageSize: versionPageSizeValue ? Number(versionPageSizeValue) : undefined,
            versionCursor: query.get("versionCursor")?.trim() || undefined,
          });
          const listing = await this.handlerTx()
            .withServiceCalls(() => [services.getPublishedListing(input)])
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (!listing) {
            return error(
              {
                code: "MARKETPLACE_LISTING_NOT_FOUND",
                message: "Marketplace listing was not found.",
              },
              404,
            );
          }
          return json(listing);
        } catch (cause) {
          if (cause instanceof z.ZodError) {
            return error(
              {
                code: "MARKETPLACE_INPUT_INVALID",
                message: cause.issues[0]?.message ?? cause.message,
              },
              400,
            );
          }
          if (cause instanceof MarketplaceListingCursorError) {
            return error({ code: "MARKETPLACE_CURSOR_INVALID", message: cause.message }, 400);
          }
          throw cause;
        }
      },
    }),
  ],
);
