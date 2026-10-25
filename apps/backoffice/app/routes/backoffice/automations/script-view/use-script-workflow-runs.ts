import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { useMemo } from "react";

import type { WorkflowVisualizationSnapshot } from "@fragno-dev/workflow-visualizer-tokens";

import { useAutomationRead } from "@/fragno/automation/lofi/replica";

import {
  projectScriptWorkflowRuns,
  selectScriptWorkflowRun,
  type AutomationWorkflowRun,
} from "./workflow-run-presentation";
import type { WorkflowRunRecordSelector } from "./workflow-run-records";

/**
 * The selected runs in full from the scope's replica, most recently updated first; none without a
 * selector or a replica.
 */
export function useWorkflowRunRecords({
  replica,
  selector,
}: {
  replica: LofiSqliteClient | null;
  selector: WorkflowRunRecordSelector | null;
}) {
  const read = useAutomationRead(
    selector ? replica : null,
    "workflowRuns",
    // Without a selector there is no replica, so nothing reads this.
    selector ?? { type: "waiting" },
  );
  return {
    instances: read.status === "ready" ? read.data : NO_RUNS,
    error: selector && read.status === "error" ? "Workflow runs could not be read." : null,
    isLoading: Boolean(selector && replica && read.status === "loading"),
  };
}

const NO_RUNS: AutomationWorkflowRun[] = [];

export function useScriptWorkflowRuns({
  absolutePath,
  replica,
  selectedInstanceId,
  visualization,
}: {
  absolutePath: string;
  replica: LofiSqliteClient;
  selectedInstanceId?: string | null;
  visualization: WorkflowVisualizationSnapshot;
}) {
  const hasWorkflowDefinitions = visualization.graph.nodes.some((node) => node.kind === "workflow");
  const records = useWorkflowRunRecords({
    replica,
    selector: hasWorkflowDefinitions ? { type: "active-codemode" } : null,
  });
  const runs = useMemo(
    () =>
      projectScriptWorkflowRuns({
        absolutePath,
        visualization,
        instances: records.instances,
      }),
    [absolutePath, records.instances, visualization],
  );

  return {
    runs,
    selectedRun: selectScriptWorkflowRun(runs, selectedInstanceId),
    error: records.error,
    isLoading: records.isLoading,
  };
}
