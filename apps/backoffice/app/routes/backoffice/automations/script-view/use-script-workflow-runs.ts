import { useMemo } from "react";

import type { WorkflowVisualizationSnapshot } from "@fragno-dev/workflow-visualizer-tokens";

import { eq, or, toArray, useLiveQuery } from "@tanstack/react-db";

import { AUTOMATION_CODEMODE_WORKFLOW } from "@/fragno/automation/engine/workflow-start";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";

import {
  projectScriptWorkflowRuns,
  selectScriptWorkflowRun,
  type AutomationWorkflowRun,
} from "./workflow-run-presentation";

type AutomationWorkflowCollections = Pick<
  AutomationCollections,
  "workflowInstances" | "workflowSteps" | "workflowStepEmissions"
>;

export function useScriptWorkflowRuns({
  absolutePath,
  collections,
  selectedInstanceId,
  visualization,
}: {
  absolutePath: string;
  collections: AutomationWorkflowCollections;
  selectedInstanceId?: string | null;
  visualization: WorkflowVisualizationSnapshot;
}) {
  const hasWorkflowDefinitions = visualization.graph.nodes.some((node) => node.kind === "workflow");
  const runsQuery = useLiveQuery(
    (query) => {
      if (!hasWorkflowDefinitions) {
        return undefined;
      }

      return query
        .from({ instance: collections.workflowInstances })
        .where(({ instance }) => eq(instance.workflowName, AUTOMATION_CODEMODE_WORKFLOW))
        .where(({ instance }) =>
          or(
            eq(instance.status, "active"),
            eq(instance.status, "waiting"),
            eq(instance.status, "paused"),
          ),
        )
        .orderBy(({ instance }) => instance.updatedAt, "desc")
        .orderBy(({ instance }) => instance.id, "desc")
        .select(({ instance }) => ({
          id: instance.id,
          instanceId: instance.instanceId,
          remoteWorkflowName: instance.remoteWorkflowName,
          status: instance.status,
          params: instance.params,
          createdAt: instance.createdAt,
          updatedAt: instance.updatedAt,
          workflowSteps: toArray(
            query
              .from({ step: collections.workflowSteps })
              .where(({ step }) => eq(step.instanceRef, instance.id))
              .orderBy(({ step }) => step.createdAt, "asc")
              .orderBy(({ step }) => step.id, "asc")
              .select(({ step }) => ({
                id: step.id,
                stepKey: step.stepKey,
                parentStepKey: step.parentStepKey,
                name: step.name,
                type: step.type,
                status: step.status,
                attempts: step.attempts,
                errorName: step.errorName,
                errorMessage: step.errorMessage,
                createdAt: step.createdAt,
              })),
          ),
          workflowStepEmissions: toArray(
            query
              .from({ emission: collections.workflowStepEmissions })
              .where(({ emission }) => eq(emission.instanceRef, instance.id))
              .orderBy(({ emission }) => emission.createdAt, "asc")
              .orderBy(({ emission }) => emission.sequence, "asc")
              .orderBy(({ emission }) => emission.id, "asc")
              .select(({ emission }) => ({
                id: emission.id,
                actor: emission.actor,
                stepKey: emission.stepKey,
                epoch: emission.epoch,
                sequence: emission.sequence,
                payload: emission.payload,
                createdAt: emission.createdAt,
              })),
          ),
        }));
    },
    [
      collections.workflowInstances,
      collections.workflowStepEmissions,
      collections.workflowSteps,
      hasWorkflowDefinitions,
    ],
  );
  const runs = useMemo(
    () =>
      projectScriptWorkflowRuns({
        absolutePath,
        visualization,
        instances: (runsQuery.data ?? []) as AutomationWorkflowRun[],
      }),
    [absolutePath, runsQuery.data, visualization],
  );
  const selectedRun = selectScriptWorkflowRun(runs, selectedInstanceId);
  const sourceError =
    hasWorkflowDefinitions && runsQuery.isError
      ? (collections.workflowInstances.utils.getLastError() ??
        collections.workflowSteps.utils.getLastError() ??
        collections.workflowStepEmissions.utils.getLastError())
      : undefined;
  const error =
    sourceError instanceof Error
      ? sourceError.message
      : hasWorkflowDefinitions && runsQuery.isError
        ? "Automation workflow synchronization failed."
        : null;

  return {
    runs,
    selectedRun,
    error,
    isLoading: hasWorkflowDefinitions && !runsQuery.isReady,
  };
}
