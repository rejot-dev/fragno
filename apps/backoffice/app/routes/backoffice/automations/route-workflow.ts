import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

export const automationRouteWorkflowName = (route: AutomationRouteDefinition) => {
  const action = route.action;
  if (action.kind === "forward_event") {
    return null;
  }
  if (action.kind === "send_workflow_event") {
    return action.workflowName;
  }
  if (action.remoteWorkflowName) {
    return action.remoteWorkflowName;
  }

  const scriptName = action.workflowScriptPath.split("/").pop();
  return scriptName?.replace(/\.workflow\.js$/u, "") || null;
};

export const automationRouteWorkflowLink = (route: AutomationRouteDefinition) => {
  const workflowName = automationRouteWorkflowName(route);
  if (!workflowName) {
    return null;
  }
  return `/workflows?${new URLSearchParams({ workflow: workflowName }).toString()}`;
};
