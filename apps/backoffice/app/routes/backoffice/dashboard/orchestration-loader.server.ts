import type { RouterContextProvider } from "react-router";

import { runtimeToolWorkflowCatalog } from "@/fragno/runtime-tools/workflow-catalog.server";
import {
  requireRouteScope,
  requireScopeSelection,
} from "@/layouts/backoffice-shell-request.server";

import { loadAutomationScriptSource } from "../automations/data.server";
import type { OrchestrationLoaderData } from "./orchestration-panel";
import { WORKFLOW_SCRIPT_PARAM } from "./path";

const EMPTY_WORKFLOW_SOURCE = { script: null, scriptError: null };

/**
 * What the orchestration panel reads from the server: the scope it graphs, the source of the
 * workflow selected in the URL, and the tools workflows can call.
 */
export async function loadOrchestration({
  context,
  url,
}: {
  context: Readonly<RouterContextProvider>;
  url: URL;
}): Promise<OrchestrationLoaderData> {
  const workflowScriptId = url.searchParams.get(WORKFLOW_SCRIPT_PARAM)?.trim() ?? "";
  return {
    selectedScope: requireScopeSelection(context),
    workflowSource: workflowScriptId
      ? await loadAutomationScriptSource({
          context,
          execution: requireRouteScope(context).execution,
          scriptId: workflowScriptId,
        })
      : EMPTY_WORKFLOW_SOURCE,
    runtimeToolCatalog: runtimeToolWorkflowCatalog,
  };
}
