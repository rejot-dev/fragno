import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";

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
