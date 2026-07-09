import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError } from "@fragno-dev/db";

import { automationFragmentDefinition } from "./definition";
import {
  AutomationEventDefinitionValidationError,
  automationEventDefinitionCreateInputSchema,
  automationEventDefinitionSchema,
  automationEventDefinitionUpdatePayloadSchema,
} from "./event-definitions";

export const automationEventDefinitionRoutes = defineRoutes(automationFragmentDefinition).create(
  ({ defineRoute, services }) => [
    defineRoute({
      method: "GET",
      path: "/event-definitions",
      outputSchema: z.array(automationEventDefinitionSchema),
      handler: async function (_request, { json }) {
        const definitions = await this.handlerTx()
          .withServiceCalls(() => [services.listEventDefinitions()] as const)
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        return json(definitions);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/event-definitions/:source/:eventType",
      outputSchema: automationEventDefinitionSchema,
      handler: async function ({ pathParams }, { json, error }) {
        const definition = await this.handlerTx()
          .withServiceCalls(
            () =>
              [
                services.getEventDefinition({
                  source: pathParams.source,
                  eventType: pathParams.eventType,
                }),
              ] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        if (!definition) {
          return error(
            {
              message: "Automation event definition not found.",
              code: "EVENT_DEFINITION_NOT_FOUND",
            },
            404,
          );
        }

        return json(definition);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/event-definitions",
      inputSchema: automationEventDefinitionCreateInputSchema,
      outputSchema: automationEventDefinitionSchema,
      handler: async function ({ input }, { json, error }) {
        const payload = await input.valid();
        try {
          const definition = await this.handlerTx()
            .withServiceCalls(() => [services.createEventDefinition(payload)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          return json(definition, { status: 201 });
        } catch (cause) {
          if (isUniqueConstraintError(cause)) {
            return error(
              {
                message: "Automation event definition source/type is already used.",
                code: "EVENT_DEFINITION_CONFLICT",
              },
              409,
            );
          }
          if (cause instanceof AutomationEventDefinitionValidationError) {
            return error(
              {
                message: cause.message,
                code: "EVENT_DEFINITION_INVALID",
              },
              400,
            );
          }
          throw cause;
        }
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/event-definitions/:source/:eventType",
      inputSchema: automationEventDefinitionUpdatePayloadSchema,
      outputSchema: automationEventDefinitionSchema,
      handler: async function ({ pathParams, input }, { json, error }) {
        const patch = await input.valid();
        let definition;
        try {
          definition = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.updateEventDefinition({
                    source: pathParams.source,
                    eventType: pathParams.eventType,
                    patch,
                  }),
                ] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
        } catch (cause) {
          if (cause instanceof AutomationEventDefinitionValidationError) {
            return error(
              {
                message: cause.message,
                code: "EVENT_DEFINITION_INVALID",
              },
              400,
            );
          }
          throw cause;
        }

        if (!definition) {
          return error(
            {
              message: "Automation event definition not found.",
              code: "EVENT_DEFINITION_NOT_FOUND",
            },
            404,
          );
        }

        return json(definition);
      },
    }),
  ],
);
