import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

import { filesExplorerPathFromScopePath } from "../files/scope";

export const automationRouteScriptLink = (
  route: AutomationRouteDefinition,
  filesScopePath: string,
) => {
  if (route.action.kind !== "start_workflow") {
    return null;
  }

  return filesExplorerPathFromScopePath(filesScopePath, route.action.workflowScriptPath);
};

export const automationEventCatalogLink = (
  eventsCatalogPath: string,
  source: string,
  eventType: string,
) =>
  `${eventsCatalogPath}?${new URLSearchParams({
    selection: "event",
    selected: `${source}:${eventType}`,
  }).toString()}`;
