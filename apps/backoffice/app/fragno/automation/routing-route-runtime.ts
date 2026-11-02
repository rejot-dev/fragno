import {
  automationRouteSchema,
  type AutomationRouteCreateInput,
  type AutomationRouteUpdateInput,
} from "@fragno-dev/backoffice-api/v0/automation";
import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type {
  AutomationsCommands,
  BackofficeObjectHandle,
} from "@/backoffice-runtime/object-registry";
import {
  BackofficeOperationError,
  backofficeOperationErrorKindForStatus,
} from "@/backoffice-runtime/operation-error";
import type { AutomationRouterRuntime } from "@/fragno/runtime-tools/families/automations-routing";

import { createAutomationsRouteCaller } from "./route-callers";

const raiseRouteError = (status: number, message: string): never => {
  throw new BackofficeOperationError(
    backofficeOperationErrorKindForStatus(status),
    `Automations backend returned ${status}: ${message}`,
  );
};

/** The error a caller sees for a forward accept the Automations object refused to write. */
function refuseForwardAccept(reason: "exists" | "members-outside-organization", id: string): never {
  throw reason === "exists"
    ? new BackofficeOperationError("conflict", `Forward accept '${id}' already exists.`)
    : new BackofficeOperationError(
        "invalid_request",
        "Only a scope an organization owns can accept forwards from its members; name the sending scope instead.",
      );
}

export const createRouteBackedAutomationRouterRuntime = ({
  object,
  execution,
}: {
  object: BackofficeObjectHandle<AutomationsCommands>;
  execution: BackofficeExecutionContext;
}): AutomationRouterRuntime => {
  const callRoute = createAutomationsRouteCaller({ object, context: { execution } });

  return {
    listRoutes: async () => {
      const response = await callRoute("GET", "/routes");
      if (response.type === "json") {
        return z.array(automationRouteSchema).parse(response.data);
      }
      if (response.type === "error") {
        raiseRouteError(response.status, response.error.message);
      }
      throw new BackofficeOperationError(
        backofficeOperationErrorKindForStatus(response.status),
        `Automations backend returned ${response.status}`,
      );
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
      throw new BackofficeOperationError(
        backofficeOperationErrorKindForStatus(response.status),
        `Automations backend returned ${response.status}`,
      );
    },
    createRoute: async (input: AutomationRouteCreateInput) => {
      const response = await callRoute("POST", "/routes", { body: input });
      if (response.type === "json") {
        return automationRouteSchema.parse(response.data);
      }
      if (response.type === "error") {
        raiseRouteError(response.status, response.error.message);
      }
      throw new BackofficeOperationError(
        backofficeOperationErrorKindForStatus(response.status),
        `Automations backend returned ${response.status}`,
      );
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
      throw new BackofficeOperationError(
        backofficeOperationErrorKindForStatus(response.status),
        `Automations backend returned ${response.status}`,
      );
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
      throw new BackofficeOperationError(
        backofficeOperationErrorKindForStatus(response.status),
        `Automations backend returned ${response.status}`,
      );
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
      throw new BackofficeOperationError(
        backofficeOperationErrorKindForStatus(response.status),
        `Automations backend returned ${response.status}`,
      );
    },
    listForwardAccepts: async () => await object.commands.listForwardAccepts(),
    createForwardAccept: async (input) => {
      const outcome = await object.commands.createForwardAccept(input);
      return outcome.ok ? outcome.accept : refuseForwardAccept(outcome.reason, input.id);
    },
    updateForwardAccept: async (input) => {
      const outcome = await object.commands.updateForwardAccept(input);
      if (outcome.ok) {
        return outcome.accept;
      }
      return outcome.reason === "not-found" ? null : refuseForwardAccept(outcome.reason, input.id);
    },
    deleteForwardAccept: async (input) => {
      await object.commands.deleteForwardAccept(input);
      return true;
    },
  };
};
