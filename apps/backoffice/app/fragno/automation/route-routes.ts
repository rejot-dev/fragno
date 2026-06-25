import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError } from "@fragno-dev/db";

import { automationFragmentDefinition } from "./definition";
import {
  automationRouteCreateInputSchema,
  automationRouteSchema,
  automationRouteUpdatePayloadSchema,
} from "./routing-schemas";

export const automationRouteRoutes = defineRoutes(automationFragmentDefinition).create(
  ({ defineRoute, services }) => [
    defineRoute({
      method: "GET",
      path: "/routes",
      outputSchema: z.array(automationRouteSchema),
      handler: async function (_request, { json }) {
        const routes = await this.handlerTx()
          .withServiceCalls(() => [services.listRoutes()] as const)
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        return json(routes);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/routes/:routeId",
      outputSchema: automationRouteSchema,
      handler: async function ({ pathParams }, { json, error }) {
        const route = await this.handlerTx()
          .withServiceCalls(() => [services.getRoute({ id: pathParams.routeId })] as const)
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        if (!route) {
          return error({ message: "Automation route not found.", code: "ROUTE_NOT_FOUND" }, 404);
        }

        return json(route);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/routes",
      inputSchema: automationRouteCreateInputSchema,
      outputSchema: automationRouteSchema,
      handler: async function ({ input }, { json, error }) {
        const payload = await input.valid();
        try {
          const route = await this.handlerTx()
            .withServiceCalls(() => [services.createRoute(payload)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          return json(route, { status: 201 });
        } catch (cause) {
          if (isUniqueConstraintError(cause)) {
            return error(
              {
                message: "Automation route id is already used.",
                code: "ROUTE_ID_CONFLICT",
              },
              409,
            );
          }
          throw cause;
        }
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/routes/:routeId",
      inputSchema: automationRouteUpdatePayloadSchema,
      outputSchema: automationRouteSchema,
      handler: async function ({ pathParams, input }, { json, error }) {
        const payload = await input.valid();
        const route = await this.handlerTx()
          .withServiceCalls(
            () => [services.updateRoute({ ...payload, id: pathParams.routeId })] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        if (!route) {
          return error({ message: "Automation route not found.", code: "ROUTE_NOT_FOUND" }, 404);
        }

        return json(route);
      },
    }),
  ],
);
