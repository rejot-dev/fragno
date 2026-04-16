import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import {
  bindAutomationIdentityActor,
  lookupAutomationIdentityBinding,
} from "../bash-runtime/automations-bash-runtime";
import { loadAutomationCatalogFromConfig, resolveAutomationFileSystem } from "./catalog";
import { automationFragmentDefinition } from "./definition";
import {
  listAutomationScenarios,
  resolveAutomationScenarioPath,
  runAutomationScenarioFile,
} from "./scenario";
import { automationFragmentSchema } from "./schema";

const identityBindingOutputSchema = z.object({
  id: z.unknown().optional(),
  source: z.string(),
  key: z.string(),
  value: z.string(),
  description: z.string().nullable().optional(),
  status: z.string(),
  linkedAt: z.unknown().optional(),
  createdAt: z.unknown().optional(),
  updatedAt: z.unknown().optional(),
});

const getOrgIdFromRequestQuery = (query: URLSearchParams) =>
  query.get("orgId")?.trim() || undefined;

const isAutomationScenarioNotFoundError = (cause: unknown): cause is Error =>
  cause instanceof Error &&
  cause.message.startsWith("Automation scenario file '") &&
  cause.message.includes("' was not found:");

export const automationFragmentRoutes = defineRoutes(automationFragmentDefinition).create(
  ({ defineRoute, config }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/scripts",
        outputSchema: z.array(z.record(z.string(), z.unknown())),
        handler: async function ({ query }, { json, error }) {
          try {
            const catalog = await loadAutomationCatalogFromConfig(config, {
              orgId: getOrgIdFromRequestQuery(query),
              purpose: "route",
            });

            return json(catalog.scripts);
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
            const catalog = await loadAutomationCatalogFromConfig(config, {
              orgId: getOrgIdFromRequestQuery(query),
              purpose: "route",
            });

            return json(catalog.bindings);
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
        path: "/scenarios",
        outputSchema: z.array(z.record(z.string(), z.unknown())),
        handler: async function ({ query }, { json, error }) {
          try {
            const fileSystem = await resolveAutomationFileSystem(config, {
              orgId: getOrgIdFromRequestQuery(query),
              purpose: "route",
            });

            return json(await listAutomationScenarios(fileSystem));
          } catch (cause) {
            return error(
              {
                message:
                  cause instanceof Error ? cause.message : "Failed to load automation scenarios.",
                code: "AUTOMATION_SCENARIOS_INVALID",
              },
              500,
            );
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/scenarios/run",
        inputSchema: z.object({
          path: z.string().trim().min(1),
        }),
        outputSchema: z.record(z.string(), z.unknown()),
        handler: async function ({ input, query }, { json, error }) {
          const payload = await input.valid();

          let scenarioPath: string;
          try {
            scenarioPath = resolveAutomationScenarioPath(payload.path);
          } catch (cause) {
            return error(
              {
                message:
                  cause instanceof Error ? cause.message : "Invalid automation scenario path.",
                code: "AUTOMATION_SCENARIO_PATH_INVALID",
              },
              400,
            );
          }

          try {
            const fileSystem = await resolveAutomationFileSystem(config, {
              orgId: getOrgIdFromRequestQuery(query),
              purpose: "route",
            });

            return json(
              await runAutomationScenarioFile({
                fileSystem,
                path: scenarioPath,
              }),
            );
          } catch (cause) {
            if (isAutomationScenarioNotFoundError(cause)) {
              return error(
                {
                  message: cause.message,
                  code: "AUTOMATION_SCENARIO_NOT_FOUND",
                },
                404,
              );
            }

            return error(
              {
                message:
                  cause instanceof Error ? cause.message : "Failed to run automation scenario.",
                code: "AUTOMATION_SCENARIO_RUN_FAILED",
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
              forSchema(automationFragmentSchema).find("identity_binding"),
            )
            .transformRetrieve(([identityBindings]) => identityBindings)
            .execute();

          return json(rows);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/identity-bindings/lookup",
        outputSchema: identityBindingOutputSchema,
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
        outputSchema: identityBindingOutputSchema,
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
