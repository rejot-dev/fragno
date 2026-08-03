import { projectPiSessionFromWorkflowInstance } from "@fragno-dev/pi-harness/types";
import { use } from "react";

import { and, eq, toArray, useLiveQuery } from "@tanstack/react-db";

import { getPiBrowserDatabase, type PiCollectionSource } from "./browser-database";
import { projectPiSessionCollectionRows } from "./session-projection";

export function usePiSessionProjection({
  source,
  workflowName,
  sessionId,
}: {
  source: PiCollectionSource;
  workflowName: string;
  sessionId: string;
}) {
  const database = use(getPiBrowserDatabase());
  const collections = database.collectionsFor(source);
  const projectionQuery = useLiveQuery(
    (query) =>
      query
        .from({ instance: collections.workflowInstances })
        .where(({ instance }) =>
          and(eq(instance.workflowName, workflowName), eq(instance.instanceId, sessionId)),
        )
        .select(({ instance }) => ({
          instanceId: instance.instanceId,
          workflowName: instance.workflowName,
          params: instance.params,
          createdAt: instance.createdAt,
          updatedAt: instance.updatedAt,
          instanceStatus: instance.status,
          workflowSteps: toArray(
            query
              .from({ step: collections.workflowSteps })
              .where(({ step }) => eq(step.instanceRef, instance.id))
              .orderBy(({ step }) => step.createdAt, "asc")
              .orderBy(({ step }) => step.id, "asc")
              .select(({ step }) => ({
                stepKey: step.stepKey,
                type: step.type,
                status: step.status,
                committedByExecutionId: step.committedByExecutionId,
                waitEventType: step.waitEventType,
                result: step.result,
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
                actor: emission.actor,
                stepKey: emission.stepKey,
                executionId: emission.executionId,
                epoch: emission.epoch,
                payload: emission.payload,
                createdAt: emission.createdAt,
              })),
          ),
        }))
        .findOne(),
    [
      collections.workflowInstances,
      collections.workflowStepEmissions,
      collections.workflowSteps,
      sessionId,
      workflowName,
    ],
  );
  const projectionRows = projectionQuery.data;
  const session = projectionRows
    ? projectPiSessionFromWorkflowInstance({
        id: projectionRows.instanceId,
        workflowName: projectionRows.workflowName,
        params: projectionRows.params,
        createdAt: projectionRows.createdAt,
        updatedAt: projectionRows.updatedAt,
      })
    : null;
  const projection = projectPiSessionCollectionRows({
    workflowName,
    sessionId,
    instance: projectionRows ? { status: projectionRows.instanceStatus } : null,
    workflowSteps: projectionRows?.workflowSteps ?? [],
    workflowStepEmissions: projectionRows?.workflowStepEmissions ?? [],
    synchronized: projectionQuery.isReady,
  });
  const sourceError = projectionQuery.isError
    ? (collections.workflowInstances.utils.getLastError() ??
      collections.workflowSteps.utils.getLastError() ??
      collections.workflowStepEmissions.utils.getLastError())
    : undefined;
  const error =
    projection.error?.message ??
    (projectionRows && !session
      ? `Workflow ${workflowName}/${sessionId} does not contain Pi session data.`
      : sourceError instanceof Error
        ? sourceError.message
        : projectionQuery.isError
          ? "Pi session synchronization failed."
          : null);

  return {
    session,
    projection,
    instanceStatus: projectionRows?.instanceStatus ?? null,
    error,
    isLoading: !projectionQuery.isReady,
  };
}
