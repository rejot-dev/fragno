import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

export type AutomationRouteWorkflowIdentity = {
  workflowName: string;
  remoteWorkflowName: string | null;
  workflowScriptPath: string | null;
};

export const automationRouteWorkflowIdentity = (
  route: AutomationRouteDefinition,
): AutomationRouteWorkflowIdentity | null => {
  const action = route.action;
  switch (action.kind) {
    case "start_workflow":
      return {
        workflowName: CODEMODE_WORKFLOW,
        remoteWorkflowName: null,
        workflowScriptPath: action.workflowScriptPath,
      };
    case "send_workflow_event":
      return null;
    case "forward_event":
      return null;
    case "reclassify_event":
      return null;
  }

  throw new Error("Unsupported automation route action kind.");
};

export const automationRouteMatchesWorkflowInstance = (
  route: AutomationRouteDefinition,
  instance: {
    workflowName: string;
    remoteWorkflowName: string | null;
    workflowScriptPath: string | null;
  },
) => {
  const identity = automationRouteWorkflowIdentity(route);
  if (!identity) {
    return false;
  }

  return (
    instance.workflowName === identity.workflowName &&
    (identity.remoteWorkflowName === null ||
      instance.remoteWorkflowName === identity.remoteWorkflowName) &&
    (identity.workflowScriptPath === null ||
      instance.workflowScriptPath === identity.workflowScriptPath)
  );
};

export const automationRouteWorkflowName = (route: AutomationRouteDefinition) => {
  const action = route.action;
  if (action.kind === "forward_event") {
    return null;
  }
  if (action.kind === "send_workflow_event") {
    return null;
  }
  if (action.kind === "reclassify_event") {
    return null;
  }

  const scriptName = action.workflowScriptPath.split("/").pop();
  return scriptName?.replace(/\.workflow\.js$/u, "") || null;
};
