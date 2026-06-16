import type { AutomationsObject } from "@/backoffice-runtime/object-registry";

import type { AutomationWorkflowRuntime } from "../runtime-tools/families/automations-workflow";
import { createWorkflowsRouteCaller } from "./route-callers";

export const createRouteBackedAutomationWorkflowRuntime = ({
  object,
  orgId,
}: {
  object: AutomationsObject;
  orgId?: string;
}): AutomationWorkflowRuntime => {
  const normalizedOrgId = orgId?.trim() || undefined;
  const callRoute = createWorkflowsRouteCaller({ object, orgId: normalizedOrgId });

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
    listWorkflows: async () => {
      const response = await callRoute("GET", "/");

      if (response.type === "json") {
        return response.data;
      }

      if (response.type === "error") {
        throw new Error(`Workflows backend returned ${response.status}: ${response.error.message}`);
      }

      throw new Error(`Workflows backend returned ${response.status}`);
    },
    listInstances: async ({ workflowName, status, remoteWorkflowName, pageSize, cursor }) => {
      const query: Record<string, string> = {};
      if (status) {
        query.status = status;
      }
      if (remoteWorkflowName) {
        query.remoteWorkflowName = remoteWorkflowName;
      }
      if (pageSize) {
        query.pageSize = String(pageSize);
      }
      if (cursor) {
        query.cursor = cursor;
      }

      const response = await callRoute("GET", "/:workflowName/instances", {
        pathParams: { workflowName },
        query,
      });

      if (response.type === "json") {
        return response.data;
      }

      if (response.type === "error") {
        throw new Error(`Workflows backend returned ${response.status}: ${response.error.message}`);
      }

      throw new Error(`Workflows backend returned ${response.status}`);
    },
    getInstance: async ({ workflowName, instanceId }) => {
      const response = await callRoute("GET", "/:workflowName/instances/:instanceId", {
        pathParams: { workflowName, instanceId },
      });

      if (response.type === "json") {
        return response.data;
      }

      if (response.type === "error") {
        throw new Error(`Workflows backend returned ${response.status}: ${response.error.message}`);
      }

      throw new Error(`Workflows backend returned ${response.status}`);
    },
    retryInstance: async ({ workflowName, instanceId, stepKey, delayMs, reason }) => {
      const response = await callRoute("POST", "/:workflowName/instances/:instanceId/retry", {
        pathParams: { workflowName, instanceId },
        body: { stepKey, delayMs, reason },
      });

      if (response.type === "json") {
        return response.data;
      }

      if (response.type === "error") {
        throw new Error(`Workflows backend returned ${response.status}: ${response.error.message}`);
      }

      throw new Error(`Workflows backend returned ${response.status}`);
    },
    getHistory: async ({ workflowName, instanceId }) => {
      const response = await callRoute("GET", "/:workflowName/instances/:instanceId/history", {
        pathParams: { workflowName, instanceId },
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
