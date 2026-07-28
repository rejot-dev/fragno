import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

import { toAutomationScriptIdFromAbsolutePath } from "./script-records";

export const automationRouteScriptLink = (
  route: AutomationRouteDefinition,
  scriptsPath: string,
) => {
  if (route.action.kind !== "start_workflow") {
    return null;
  }

  const scriptId = toAutomationScriptIdFromAbsolutePath(route.action.workflowScriptPath);
  return `${scriptsPath}?${new URLSearchParams({ script: scriptId }).toString()}`;
};

export const automationEventCatalogLink = (eventsCatalogPath: string, eventType: string) =>
  `${eventsCatalogPath}?${new URLSearchParams({ search: eventType }).toString()}`;
