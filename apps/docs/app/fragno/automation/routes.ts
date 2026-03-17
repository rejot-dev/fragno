import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { automationFragmentDefinition } from "./definition";
import { automationFragmentSchema } from "./schema";

const automationScriptEngines = ["bash"] as const;

export const automationFragmentRoutes = defineRoutes(automationFragmentDefinition).create(
  ({ defineRoute }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/scripts",
        outputSchema: z.array(z.record(z.string(), z.unknown())),
        handler: async function (_, { json }) {
          const rows = await this.handlerTx()
            .retrieve(({ forSchema }) => forSchema(automationFragmentSchema).find("script"))
            .transformRetrieve(([scripts]) => scripts)
            .execute();

          return json(rows);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/scripts",
        inputSchema: z.object({
          key: z
            .string()
            .trim()
            .min(1)
            .regex(/^[a-z0-9-_]+$/),
          name: z.string().trim().min(1),
          engine: z.enum(automationScriptEngines).default("bash"),
          script: z.string().trim().min(1),
          version: z.number().int().min(1).default(1),
          enabled: z.boolean().default(true),
        }),
        outputSchema: z.object({ id: z.string() }),
        handler: async function ({ input }, { json }) {
          const payload = await input.valid();
          const result = await this.handlerTx()
            .mutate(({ forSchema }) => {
              return forSchema(automationFragmentSchema).create("script", {
                key: payload.key,
                name: payload.name,
                engine: payload.engine,
                script: payload.script,
                version: payload.version,
                enabled: payload.enabled,
              });
            })
            .transform(({ mutateResult }) => ({ id: String(mutateResult) }))
            .execute();

          return json(result);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/bindings",
        outputSchema: z.array(z.record(z.string(), z.unknown())),
        handler: async function (_, { json }) {
          const rows = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(automationFragmentSchema).find("trigger_binding"),
            )
            .transformRetrieve(([bindings]) => bindings)
            .execute();

          return json(rows);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/identity-bindings",
        outputSchema: z.array(z.record(z.string(), z.unknown())),
        handler: async function (_, { json }) {
          const rows = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(automationFragmentSchema).find("identity_binding"),
            )
            .transformRetrieve(([identityBindings]) => identityBindings)
            .execute();

          return json(rows);
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
              const table = forSchema(automationFragmentSchema);
              const now = table.now();

              table.update("identity_binding", existing.id, (b) =>
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
      defineRoute({
        method: "POST",
        path: "/bindings",
        inputSchema: z.object({
          source: z.string().trim().min(1),
          eventType: z.string(),
          scriptId: z.string(),
          enabled: z.boolean().default(true),
        }),
        outputSchema: z.object({ id: z.string() }),
        handler: async function ({ input }, { json, error }) {
          const payload = await input.valid();

          const { script, existing } = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const table = forSchema(automationFragmentSchema);

              return table
                .findFirst("script", (s) =>
                  s.whereIndex("primary", (eb) => eb("id", "=", payload.scriptId)),
                )
                .findFirst("trigger_binding", (b) =>
                  b.whereIndex("idx_trigger_binding_source_event", (eb) =>
                    eb.and(
                      eb("source", "=", payload.source),
                      eb("eventType", "=", payload.eventType),
                    ),
                  ),
                );
            })
            .transformRetrieve(([script, existing]) => ({ script, existing }))
            .execute();

          if (!script) {
            return error(
              {
                message: `Script ${payload.scriptId} not found.`,
                code: "SCRIPT_NOT_FOUND",
              },
              404,
            );
          }

          if (existing) {
            await this.handlerTx()
              .mutate(({ forSchema }) => {
                forSchema(automationFragmentSchema).update("trigger_binding", existing.id, (b) =>
                  b
                    .set({
                      source: payload.source,
                      eventType: payload.eventType,
                      scriptId: payload.scriptId,
                      enabled: payload.enabled,
                    })
                    .check(),
                );
              })
              .execute();

            return json({ id: String(existing.id) });
          }

          const result = await this.handlerTx()
            .mutate(({ forSchema }) => {
              return forSchema(automationFragmentSchema).create("trigger_binding", {
                source: payload.source,
                eventType: payload.eventType,
                scriptId: payload.scriptId,
                enabled: payload.enabled,
              });
            })
            .transform(({ mutateResult }) => ({ id: String(mutateResult) }))
            .execute();

          return json(result);
        },
      }),
    ];
  },
);
