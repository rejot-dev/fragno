import type {
  OrchestrationExternal,
  OrchestrationExternalCall,
} from "@fragno-private/design-system/orchestration/orchestration-universe-model";

import { visualizeWorkflowScript } from "@/fragno/automation/workflow-visualizations";
import {
  resolveWorkflowRuntimeToolCalls,
  type RuntimeToolWorkflowDescriptor,
} from "@/fragno/runtime-tools/workflow-catalog";

import { workflowTargetId } from "./orchestration-graph";

/** A workflow script as a run kept it: its path and source. */
export type WorkflowProgram = { filename: string; code: string };

/** A workflow that calls an outside system, by the workflow's target ID in its scope's graph. */
export type WorkflowOutsideCall = Omit<OrchestrationExternalCall, "scopeId">;

/**
 * The systems outside Backoffice that workflows reach through runtime tools, with the tools that
 * reach each. Integrations share one system until a call names its connection.
 */
const OUTSIDE_SYSTEMS: readonly (OrchestrationExternal & {
  reachedBy: (tool: RuntimeToolWorkflowDescriptor) => boolean;
})[] = [
  { id: "web", label: "Web", icon: "globe", reachedBy: (tool) => tool.namespace === "web" },
  { id: "models", label: "Models", icon: "cpu", reachedBy: (tool) => tool.namespace === "models" },
  {
    id: "browser-run",
    label: "Browser Run",
    icon: "monitor",
    reachedBy: (tool) => tool.namespace === "cloudflare",
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: "link",
    reachedBy: (tool) => tool.qualifiedName === "integrations.execute",
  },
];

/** Every outside system the universe can show; it shows those a workflow on a planet calls. */
export const ORCHESTRATION_OUTSIDE_SYSTEMS: readonly OrchestrationExternal[] = OUTSIDE_SYSTEMS.map(
  ({ id, label, icon }) => ({ id, label, icon }),
);

/** Which outside systems each workflow script calls in its steps, once per workflow and system. */
export function workflowOutsideCalls(
  programs: readonly WorkflowProgram[],
  catalog: readonly RuntimeToolWorkflowDescriptor[],
): WorkflowOutsideCall[] {
  return programs.flatMap(({ filename, code }) => {
    const visualization = visualizeWorkflowScript(filename, code);
    const tools = [...resolveWorkflowRuntimeToolCalls({ visualization, catalog }).values()]
      .flat()
      .map(({ tool }) => tool);
    return OUTSIDE_SYSTEMS.filter((system) => tools.some(system.reachedBy)).map((system) => ({
      workflowId: workflowTargetId(filename),
      externalId: system.id,
    }));
  });
}
