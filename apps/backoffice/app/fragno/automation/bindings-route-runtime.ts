import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { AutomationsObject } from "@/backoffice-runtime/object-registry";

import type { AutomationStoreRuntime } from "../runtime-tools/families/automations-bindings";
import { createAutomationsRouteCaller } from "./route-callers";

export const createRouteBackedAutomationStoreRuntime = ({
  object,
  scope,
}: {
  object: AutomationsObject;
  scope?: BackofficeContextScope;
}): AutomationStoreRuntime => {
  const callRoute = createAutomationsRouteCaller({ object, scope });

  return {
    get: async ({ key }) => {
      const response = await callRoute("GET", "/store/get", { query: { key } });

      if (response.type === "error" && response.status === 404) {
        return null;
      }

      if (response.type === "json") {
        return response.data;
      }

      if (response.type === "error") {
        throw new Error(
          `Automations backend returned ${response.status}: ${response.error.message}`,
        );
      }

      throw new Error(`Automations backend returned ${response.status}`);
    },
    set: async (args) => {
      const response = await callRoute("POST", "/store/set", { body: args });

      if (response.type === "json") {
        return response.data;
      }

      if (response.type === "error") {
        throw new Error(
          `Automations backend returned ${response.status}: ${response.error.message}`,
        );
      }

      throw new Error(`Automations backend returned ${response.status}`);
    },
    delete: async (args) => {
      const response = await callRoute("POST", "/store/delete", { body: args });

      if (response.type === "error" && response.status === 404) {
        return null;
      }

      if (response.type === "json") {
        return response.data;
      }

      if (response.type === "error") {
        throw new Error(
          `Automations backend returned ${response.status}: ${response.error.message}`,
        );
      }

      throw new Error(`Automations backend returned ${response.status}`);
    },
    list: async ({ prefix, limit }) => {
      const response = await callRoute("GET", "/store", {
        query: {
          ...(typeof prefix === "string" ? { prefix } : {}),
          ...(typeof limit === "number" ? { limit: String(limit) } : {}),
        },
      });

      if (response.type === "json") {
        return response.data;
      }

      if (response.type === "error") {
        throw new Error(
          `Automations backend returned ${response.status}: ${response.error.message}`,
        );
      }

      throw new Error(`Automations backend returned ${response.status}`);
    },
  };
};
