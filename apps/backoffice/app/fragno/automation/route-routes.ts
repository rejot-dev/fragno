import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError } from "@fragno-dev/db";

import { automationFragmentDefinition } from "./definition";
import { isAutomationScheduleError } from "./route-triggers";
import {
  automationRouteCreateInputSchema,
  automationRouteSchema,
  automationRouteUpdatePayloadSchema,
} from "./routing-schemas";

const routeError = (cause: unknown) =>
  isAutomationScheduleError(cause)
    ? {
        message: cause.message,
        code: "SCHEDULE_CADENCE_INVALID" as const,
        status: 400 as const,
      }
    : null;

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
          const known = routeError(cause);
          if (known) {
            return error({ message: known.message, code: known.code }, known.status);
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
        try {
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
        } catch (cause) {
          const known = routeError(cause);
          if (known) {
            return error({ message: known.message, code: known.code }, known.status);
          }
          throw cause;
        }
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/routes/:routeId",
      outputSchema: z.object({ deleted: z.literal(true) }),
      handler: async function ({ pathParams }, { json }) {
        await this.handlerTx()
          .withServiceCalls(() => [services.deleteRoute({ id: pathParams.routeId })] as const)
          .execute();
        return json({ deleted: true });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/routes/:routeId/trigger-now",
      outputSchema: z.object({ accepted: z.literal(true), eventId: z.string() }),
      handler: async function ({ pathParams }, { json, error }) {
        const result = await this.handlerTx()
          .withServiceCalls(
            () => [services.triggerScheduledRouteNow({ id: pathParams.routeId })] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        if (result.kind === "missing") {
          return error({ message: "Automation route not found.", code: "ROUTE_NOT_FOUND" }, 404);
        }
        if (result.kind === "not-scheduled") {
          return error(
            {
              message: "Automation route does not have a scheduled trigger.",
              code: "ROUTE_NOT_SCHEDULED",
            },
            409,
          );
        }
        return json({ accepted: true, eventId: result.eventId });
      },
    }),
  ],
);
