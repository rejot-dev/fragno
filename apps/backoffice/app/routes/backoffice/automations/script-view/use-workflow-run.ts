import { useMemo } from "react";

import type { WorkflowVisualizationSnapshot } from "@fragno-dev/workflow-visualizer-tokens";

import { useWorkflowRunRecords, type WorkflowRunCollections } from "./use-script-workflow-runs";
import { projectWorkflowRun, type WorkflowRunReference } from "./workflow-run-presentation";

export function useWorkflowRun({
  collections,
  reference,
  visualization,
}: {
  collections?: WorkflowRunCollections;
  reference: WorkflowRunReference | null;
  visualization: WorkflowVisualizationSnapshot;
}) {
  const records = useWorkflowRunRecords({
    collections,
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

export type { WorkflowRunCollections } from "./use-script-workflow-runs";
