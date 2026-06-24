import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { AutomationStoreProtectedEntryError } from "./bindings-storage-runtime";
import { automationFragmentDefinition } from "./definition";
import {
  AutomationStoreVerificationError,
  automationStoreDeleteResultSchema,
  automationStoreEntrySchema,
  automationStoreListInputSchema,
  automationStoreSetInputSchema,
} from "./store";

export const automationStoreRoutes = defineRoutes(automationFragmentDefinition).create(
  ({ defineRoute, services }) => [
    defineRoute({
      method: "GET",
      path: "/store",
      outputSchema: z.array(automationStoreEntrySchema),
      handler: async function ({ query }, { json, error }) {
        const prefix = query.get("prefix");
        const limitRaw = query.get("limit")?.trim();
        const limit = limitRaw ? Number(limitRaw) : undefined;

        if (
          limitRaw &&
          (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 || limit > 500)
        ) {
          return error(
            {
              message: "Store list limit must be a positive integer no greater than 500.",
              code: "STORE_LIST_LIMIT_INVALID",
            },
            400,
          );
        }

        const parsed = automationStoreListInputSchema.safeParse({
          ...(typeof prefix === "string" ? { prefix } : {}),
          limit,
        });
        if (!parsed.success) {
          return error(
            {
              message: "Invalid store list input.",
              code: "STORE_LIST_INPUT_INVALID",
            },
            400,
          );
        }

        const entries = await this.handlerTx()
          .withServiceCalls(() => [services.listStoreEntries(parsed.data)] as const)
          .transform(({ serviceResult: [result] }) => result)
          .execute();
        return json(entries);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/store/get",
      outputSchema: automationStoreEntrySchema,
      handler: async function ({ query }, { json, error }) {
        const key = query.get("key")?.trim();

        if (!key) {
          return error(
            {
              message: "Missing key query parameter.",
              code: "KEY_REQUIRED",
            },
            400,
          );
        }

        const entry = await this.handlerTx()
          .withServiceCalls(() => [services.getStoreEntry({ key })] as const)
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        if (!entry) {
          return error(
            {
              message: `Store entry not found for ${key}.`,
              code: "STORE_ENTRY_NOT_FOUND",
            },
            404,
          );
        }

        return json(entry);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/store/set",
      inputSchema: automationStoreSetInputSchema,
      outputSchema: automationStoreEntrySchema,
      handler: async function ({ input }, { json, error }) {
        const payload = await input.valid();
        try {
          const entry = await this.handlerTx()
            .withServiceCalls(() => [services.setStoreEntry(payload)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          return json(entry);
        } catch (cause) {
          if (cause instanceof AutomationStoreVerificationError) {
            return error(
              {
                message: cause.message,
                code: "STORE_VERIFICATION_FAILED",
              },
              400,
            );
          }
          throw cause;
        }
      },
    }),
    defineRoute({
      method: "POST",
      path: "/store/delete",
      inputSchema: z.object({
        key: z.string().trim().min(1),
      }),
      outputSchema: automationStoreDeleteResultSchema,
      handler: async function ({ input }, { json, error }) {
        const payload = await input.valid();
        let result;
        try {
          result = await this.handlerTx()
            .withServiceCalls(() => [services.deleteStoreEntry(payload)] as const)
            .transform(({ serviceResult: [serviceResult] }) => serviceResult)
            .execute();
        } catch (cause) {
          if (cause instanceof AutomationStoreProtectedEntryError) {
            return error(
              {
                message: cause.message,
                code: "STORE_ENTRY_PROTECTED",
              },
              403,
            );
          }
          throw cause;
        }

        if (!result) {
          return error(
            {
              message: `Store entry not found for ${payload.key}.`,
              code: "STORE_ENTRY_NOT_FOUND",
            },
            404,
          );
        }

        return json(result);
      },
    }),
  ],
);
