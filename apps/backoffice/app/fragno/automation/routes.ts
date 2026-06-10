import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import {
  deleteAutomationStoreEntry,
  getAutomationStoreEntry,
  listAutomationStoreEntries,
  setAutomationStoreEntry,
} from "./bindings-storage-runtime";
import { loadAutomationCatalogFromConfig } from "./catalog";
import { automationFragmentDefinition } from "./definition";
import { automationStoreDeleteResultSchema, automationStoreEntrySchema } from "./store";

const getOrgIdFromRequestQuery = (query: URLSearchParams) =>
  query.get("orgId")?.trim() || undefined;

export const automationFragmentRoutes = defineRoutes(automationFragmentDefinition).create(
  ({ defineRoute, config }) => {
    const loadRouteCatalog = (query: URLSearchParams) =>
      loadAutomationCatalogFromConfig(config, {
        orgId: getOrgIdFromRequestQuery(query),
        purpose: "route",
      });

    return [
      defineRoute({
        method: "GET",
        path: "/scripts",
        outputSchema: z.array(z.record(z.string(), z.unknown())),
        handler: async function ({ query }, { json, error }) {
          try {
            return json((await loadRouteCatalog(query)).scripts);
          } catch (cause) {
            return error(
              {
                message:
                  cause instanceof Error ? cause.message : "Failed to load automation scripts.",
                code: "AUTOMATION_CATALOG_INVALID",
              },
              500,
            );
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/store",
        outputSchema: z.array(automationStoreEntrySchema),
        handler: async function (_, { json }) {
          return json(await listAutomationStoreEntries(this));
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

          const entry = await getAutomationStoreEntry(this, { key });

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
        inputSchema: z.object({
          key: z.string().trim().min(1),
          value: z.string().trim().min(1),
        }),
        outputSchema: automationStoreEntrySchema,
        handler: async function ({ input }, { json }) {
          const payload = await input.valid();
          const entry = await setAutomationStoreEntry(this, payload);
          return json(entry);
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
          const result = await deleteAutomationStoreEntry(this, payload);

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
    ];
  },
);
