import type { PiSession } from "@fragno-dev/pi-harness/types";
import { use } from "react";

import { and, eq, toArray, useLiveQuery } from "@tanstack/react-db";

import { getPiTanStackDatabase, type PiPersistenceSource } from "./database";
import { projectPiSessionCollectionRows } from "./session-projection";

export function usePiSessionProjection({
  source,
  workflowName,
  sessionId,
}: {
  source: PiPersistenceSource;
  workflowName: string;
  sessionId: string;
}) {
  const database = use(getPiTanStackDatabase());
  const collections = database.collectionsFor(source);
  const sessionQuery = useLiveQuery(
    (query) =>
      query
        .from({ session: collections.sessions })
        .where(({ session }) =>
          and(eq(session.workflowName, workflowName), eq(session.sessionId, sessionId)),
        )
        .select(({ session }) => ({
          id: session.sessionId,
          name: session.name,
          agent: session.agent,
          workflowName: session.workflowName,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }))
        .findOne(),
    [collections.sessions, sessionId, workflowName],
  );
  const projectionQuery = useLiveQuery(
    (query) =>
      query
        .from({ instance: collections.workflowInstances })
        .where(({ instance }) =>
          and(eq(instance.workflowName, workflowName), eq(instance.instanceId, sessionId)),
        )
        .select(({ instance }) => ({
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
                stepKey: emission.stepKey,
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
  const session: PiSession | null = sessionQuery.data ?? null;
  const projectionRows = projectionQuery.data;
  const projection = projectPiSessionCollectionRows({
    workflowName,
    sessionId,
    instance: projectionRows ? { status: projectionRows.instanceStatus } : null,
    workflowSteps: projectionRows?.workflowSteps ?? [],
    workflowStepEmissions: projectionRows?.workflowStepEmissions ?? [],
    synchronized: projectionQuery.isReady,
  });
  const sourceError =
    sessionQuery.isError || projectionQuery.isError
      ? (collections.sessions.utils.getLastError() ??
        collections.workflowInstances.utils.getLastError() ??
        collections.workflowSteps.utils.getLastError() ??
        collections.workflowStepEmissions.utils.getLastError())
      : undefined;
  const error =
    projection.error?.message ??
    (sourceError instanceof Error
      ? sourceError.message
      : sessionQuery.isError || projectionQuery.isError
        ? "Pi session synchronization failed."
        : null);

  return {
    session,
    projection,
    error,
    isLoading: !sessionQuery.isReady || !projectionQuery.isReady,
  };
}
