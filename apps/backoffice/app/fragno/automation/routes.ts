import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import {
  bindAutomationIdentityActor,
  lookupAutomationIdentityBinding,
} from "./bindings-storage-runtime";
import { loadAutomationCatalogFromConfig } from "./catalog";
import { automationFragmentDefinition } from "./definition";
import { automationIdentityBindingRecordSchema } from "./identity";
import { automationFragmentSchema } from "./schema";

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
        path: "/bindings",
        outputSchema: z.array(z.record(z.string(), z.unknown())),
        handler: async function ({ query }, { json, error }) {
          try {
            return json((await loadRouteCatalog(query)).bindings);
          } catch (cause) {
            return error(
              {
                message:
                  cause instanceof Error ? cause.message : "Failed to load automation bindings.",
                code: "AUTOMATION_CATALOG_INVALID",
              },
              500,
            );
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/identity-bindings",
        outputSchema: z.array(z.record(z.string(), z.unknown())),
        handler: async function (_, { json }) {
          const rows = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(automationFragmentSchema).find("identity_binding", (b) =>
                b.whereIndex("primary"),
              ),
            )
            .transformRetrieve(([identityBindings]) => identityBindings)
            .execute();

          return json(rows);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/identity-bindings/lookup",
        outputSchema: automationIdentityBindingRecordSchema,
        handler: async function ({ query }, { json, error }) {
          const source = query.get("source")?.trim();
          const key = query.get("key")?.trim();

          if (!source) {
            return error(
              {
                message: "Missing source query parameter.",
                code: "SOURCE_REQUIRED",
              },
              400,
            );
          }

          if (!key) {
            return error(
              {
                message: "Missing key query parameter.",
                code: "KEY_REQUIRED",
              },
              400,
            );
          }

          const binding = await lookupAutomationIdentityBinding(this, {
            source,
            key,
          });

          if (!binding) {
            return error(
              {
                message: `Identity binding not found for ${source}:${key}.`,
                code: "IDENTITY_BINDING_NOT_FOUND",
              },
              404,
            );
          }

          return json(binding);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/identity-bindings/bind",
        inputSchema: z.object({
          source: z.string().trim().min(1),
          key: z.string().trim().min(1),
          value: z.string().trim().min(1),
          description: z.string().optional(),
        }),
        outputSchema: automationIdentityBindingRecordSchema,
        handler: async function ({ input }, { json }) {
          const payload = await input.valid();
          const binding = await bindAutomationIdentityActor(this, payload);
          return json(binding);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/identity-bindings/:bindingId/revoke",
        outputSchema: z.object({ ok: z.literal(true), id: z.string() }),
        handler: async function ({ pathParams }, { json, error }) {
          const existing = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(automationFragmentSchema).findFirst("identity_binding", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.bindingId)),
              ),
            )
            .transformRetrieve(([binding]) => binding)
            .execute();

          if (!existing) {
            return error(
              {
                message: `Identity binding ${pathParams.bindingId} not found.`,
                code: "IDENTITY_BINDING_NOT_FOUND",
              },
              404,
            );
          }

          const result = await this.handlerTx()
            .mutate(({ forSchema }) => {
              const uow = forSchema(automationFragmentSchema);
              const now = uow.now();

              uow.update("identity_binding", existing.id, (b) =>
                b
                  .set({
                    status: "revoked",
                    updatedAt: now,
                  })
                  .check(),
              );

              return { ok: true as const, id: pathParams.bindingId };
            })
            .transform(({ mutateResult }) => mutateResult)
            .execute();

          return json(result);
        },
      }),
    ];
  },
);
