import type { AutomationWorkflowRuntime } from "../runtime-tools/families/automations-workflow";
import { createWorkflowsRouteCaller } from "./route-callers";

export const createRouteBackedAutomationWorkflowRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): AutomationWorkflowRuntime => {
  const normalizedOrgId = orgId.trim();
  if (!normalizedOrgId) {
    throw new Error("Workflows backend requires an organisation id");
  }

  const callRoute = createWorkflowsRouteCaller(env, normalizedOrgId);

  return {
    createInstance: async ({ workflowName, remoteWorkflowName, instanceId, params }) => {
      const response = await callRoute("POST", "/:workflowName/instances", {
        pathParams: { workflowName },
        body: { id: instanceId, params, remoteWorkflowName },
      });

      if (response.type === "json") {
        return { workflowName, instanceId: response.data.id };
      }

      if (response.type === "error") {
        throw new Error(`Workflows backend returned ${response.status}: ${response.error.message}`);
      }

      throw new Error(`Workflows backend returned ${response.status}`);
    },
    getStatus: async ({ workflowName, instanceId }) => {
      const response = await callRoute("GET", "/:workflowName/instances/:instanceId", {
        pathParams: { workflowName, instanceId },
      });

      if (response.type === "json") {
        return response.data.details;
      }

      if (response.type === "error") {
        throw new Error(`Workflows backend returned ${response.status}: ${response.error.message}`);
      }

      throw new Error(`Workflows backend returned ${response.status}`);
    },
    sendEvent: async ({ workflowName, instanceId, type, payload }) => {
      const response = await callRoute("POST", "/:workflowName/instances/:instanceId/events", {
        pathParams: { workflowName, instanceId },
        body: { type, payload },
      });

      if (response.type === "json") {
        return response.data;
      }

      if (response.type === "error") {
        throw new Error(`Workflows backend returned ${response.status}: ${response.error.message}`);
      }

      throw new Error(`Workflows backend returned ${response.status}`);
    },
  };
};
