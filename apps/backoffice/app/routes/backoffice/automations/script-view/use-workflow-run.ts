import { useMemo } from "react";

import type { WorkflowVisualizationSnapshot } from "@fragno-dev/workflow-visualizer-tokens";

import { useWorkflowRunRecords, type WorkflowRunSource } from "./use-script-workflow-runs";
import { projectWorkflowRun, type WorkflowRunReference } from "./workflow-run-presentation";

export function useWorkflowRun({
  source,
  reference,
  visualization,
}: {
  source?: WorkflowRunSource;
  reference: WorkflowRunReference | null;
  visualization: WorkflowVisualizationSnapshot;
}) {
  const records = useWorkflowRunRecords({
    source,
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

export type { WorkflowRunCollections, WorkflowRunSource } from "./use-script-workflow-runs";
