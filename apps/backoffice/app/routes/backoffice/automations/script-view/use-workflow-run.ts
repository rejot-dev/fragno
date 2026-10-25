import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { useMemo } from "react";

import type { WorkflowVisualizationSnapshot } from "@fragno-dev/workflow-visualizer-tokens";

import { useWorkflowRunRecords } from "./use-script-workflow-runs";
import { projectWorkflowRun, type WorkflowRunReference } from "./workflow-run-presentation";

export function useWorkflowRun({
  replica,
  reference,
  visualization,
}: {
  replica: LofiSqliteClient | null;
  reference: WorkflowRunReference | null;
  visualization: WorkflowVisualizationSnapshot;
}) {
  const records = useWorkflowRunRecords({
    replica,
    selector: reference
      ? {
          type: "instance",
          workflowName: reference.workflowName,
          instanceId: reference.instanceId,
        }
      : null,
  });
  const selectedRun = useMemo(() => {
    const instance = records.instances[0];
    return instance ? projectWorkflowRun({ visualization, instance }) : null;
  }, [records.instances, visualization]);

  return {
    selectedRun,
    error: records.error,
    isLoading: records.isLoading,
  };
}
