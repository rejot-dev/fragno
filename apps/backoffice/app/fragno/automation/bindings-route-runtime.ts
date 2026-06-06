import type { AutomationBindingsRuntime } from "../runtime-tools/families/automations-bindings";
import { createAutomationBindingsRuntime } from "./bindings-storage-runtime";
import { createAutomationsRouteCaller } from "./route-callers";

export const createRouteBackedAutomationBindingsRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): AutomationBindingsRuntime => {
  const normalizedOrgId = orgId.trim();
  if (!normalizedOrgId) {
    throw new Error("Automation bindings backend requires an organisation id");
  }

  const callRoute = createAutomationsRouteCaller(env, normalizedOrgId);

  return createAutomationBindingsRuntime({
    lookupBinding: async ({ source, key }) => {
      const response = await callRoute("GET", "/identity-bindings/lookup", {
        query: { source, key },
      });

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
    bindActor: async (args) => {
      const response = await callRoute("POST", "/identity-bindings/bind", { body: args });

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
  });
};
