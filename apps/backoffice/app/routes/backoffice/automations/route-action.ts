import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

export const automationRouteActionLabel = (route: AutomationRouteDefinition) => {
  switch (route.action.kind) {
    case "start_workflow":
      return "Start workflow";
    case "send_workflow_event":
      return "Send workflow event";
    case "forward_event":
      return "Forward event";
  }

  throw new Error("Unsupported automation route action kind.");
};
