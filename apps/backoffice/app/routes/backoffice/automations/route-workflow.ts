import { AUTOMATION_CODEMODE_WORKFLOW } from "@/fragno/automation/engine/workflow-start";
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
        workflowName: AUTOMATION_CODEMODE_WORKFLOW,
        remoteWorkflowName: action.remoteWorkflowName ?? null,
        workflowScriptPath: action.workflowScriptPath,
      };
    case "send_workflow_event":
      return {
        workflowName: action.workflowName,
        remoteWorkflowName: action.remoteWorkflowName,
        workflowScriptPath: null,
      };
    case "forward_event":
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
    instance.remoteWorkflowName === identity.remoteWorkflowName &&
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
    return action.remoteWorkflowName;
  }
  if (action.remoteWorkflowName) {
    return action.remoteWorkflowName;
  }

  const scriptName = action.workflowScriptPath.split("/").pop();
  return scriptName?.replace(/\.workflow\.js$/u, "") || null;
};
