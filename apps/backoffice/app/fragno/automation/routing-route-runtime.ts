import { z } from "zod";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { AutomationsObject } from "@/backoffice-runtime/object-registry";
import {
  automationRouteSchema,
  type AutomationRouteCreateInput,
  type AutomationRouteUpdateInput,
} from "@/fragno/automation/routing-schemas";
import type { AutomationRouterRuntime } from "@/fragno/runtime-tools/families/automations-routing";

import { createAutomationsRouteCaller } from "./route-callers";

const raiseRouteError = (status: number, message: string): never => {
  throw new Error(`Automations backend returned ${status}: ${message}`);
};

export const createRouteBackedAutomationRouterRuntime = ({
  object,
  scope,
}: {
  object: AutomationsObject;
  scope?: BackofficeContextScope;
}): AutomationRouterRuntime => {
  const callRoute = createAutomationsRouteCaller({ object, scope });

  return {
    listRoutes: async () => {
      const response = await callRoute("GET", "/routes");
      if (response.type === "json") {
        return z.array(automationRouteSchema).parse(response.data);
      }
      if (response.type === "error") {
        raiseRouteError(response.status, response.error.message);
      }
      throw new Error(`Automations backend returned ${response.status}`);
    },
    getRoute: async ({ id }) => {
      const response = await callRoute("GET", "/routes/:routeId", {
        pathParams: { routeId: id },
      });
      if (response.type === "error" && response.status === 404) {
        return null;
      }
      if (response.type === "json") {
        return automationRouteSchema.parse(response.data);
      }
      if (response.type === "error") {
        raiseRouteError(response.status, response.error.message);
      }
      throw new Error(`Automations backend returned ${response.status}`);
    },
    createRoute: async (input: AutomationRouteCreateInput) => {
      const response = await callRoute("POST", "/routes", { body: input });
      if (response.type === "json") {
        return automationRouteSchema.parse(response.data);
      }
      if (response.type === "error") {
        raiseRouteError(response.status, response.error.message);
      }
      throw new Error(`Automations backend returned ${response.status}`);
    },
    updateRoute: async (input: AutomationRouteUpdateInput) => {
      const { id, ...body } = input;
      const response = await callRoute("PATCH", "/routes/:routeId", {
        pathParams: { routeId: id },
        body,
      });
      if (response.type === "error" && response.status === 404) {
        return null;
      }
      if (response.type === "json") {
        return automationRouteSchema.parse(response.data);
      }
      if (response.type === "error") {
        raiseRouteError(response.status, response.error.message);
      }
      throw new Error(`Automations backend returned ${response.status}`);
    },
    deleteRoute: async ({ id }) => {
      const response = await callRoute("DELETE", "/routes/:routeId", {
        pathParams: { routeId: id },
      });
      if (response.type === "json") {
        return z.object({ deleted: z.literal(true) }).parse(response.data).deleted;
      }
      if (response.type === "error") {
        raiseRouteError(response.status, response.error.message);
      }
      throw new Error(`Automations backend returned ${response.status}`);
    },
    triggerScheduledRouteNow: async ({ id }) => {
      const response = await callRoute("POST", "/routes/:routeId/trigger-now", {
        pathParams: { routeId: id },
      });
      if (response.type === "error" && response.status === 404) {
        return null;
      }
      if (response.type === "json") {
        return z.object({ accepted: z.literal(true), eventId: z.string() }).parse(response.data);
      }
      if (response.type === "error") {
        raiseRouteError(response.status, response.error.message);
      }
      throw new Error(`Automations backend returned ${response.status}`);
    },
  };
};
