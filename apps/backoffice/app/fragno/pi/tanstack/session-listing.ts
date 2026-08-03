import {
  projectPiSessionFromWorkflowInstance,
  type PiSession,
  type PiWorkflowStatus,
} from "@fragno-dev/pi-harness/types";

import { eq, type InitialQueryBuilder } from "@tanstack/react-db";

import type { PiCollections } from "./collections";

const PI_WORKFLOW_STATUSES = new Set<string>([
  "active",
  "waiting",
  "paused",
  "complete",
  "errored",
  "terminated",
]);

type PiSessionListingRow = {
  sessionId: string;
  workflowName: string;
  params: unknown;
  createdAt: Date;
  updatedAt: Date;
  workflowStatus: string;
};

export type PiSessionListingSnapshot = {
  sessions: PiSession[];
  workflowStatuses: Record<string, PiWorkflowStatus | null>;
};

export type PiSessionListingState =
  | { status: "synchronizing"; snapshot: PiSessionListingSnapshot }
  | { status: "ready"; snapshot: PiSessionListingSnapshot }
  | { status: "error"; snapshot: PiSessionListingSnapshot; error: string };

const toPiWorkflowStatus = (status: string): PiWorkflowStatus | null =>
  PI_WORKFLOW_STATUSES.has(status) ? (status as PiWorkflowStatus) : null;

export function buildPiSessionListingQuery(
  query: InitialQueryBuilder,
  {
    collections,
    workflowName,
    limit,
  }: {
    collections: Pick<PiCollections, "workflowInstances">;
    workflowName: string;
    limit: number;
  },
) {
  return query
    .from({ instance: collections.workflowInstances })
    .where(({ instance }) => eq(instance.workflowName, workflowName))
    .orderBy(({ instance }) => instance.createdAt, "desc")
    .orderBy(({ instance }) => instance.id, "desc")
    .limit(limit)
    .select(({ instance }) => ({
      sessionId: instance.instanceId,
      workflowName: instance.workflowName,
      params: instance.params,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      workflowStatus: instance.status,
    }));
}

export function projectPiSessionListingRows(
  rows: readonly PiSessionListingRow[],
): PiSessionListingSnapshot {
  const sessions: PiSession[] = [];
  const workflowStatuses: Record<string, PiWorkflowStatus | null> = {};

  for (const row of rows) {
    const session = projectPiSessionFromWorkflowInstance({
      id: row.sessionId,
      workflowName: row.workflowName,
      params: row.params,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    if (!session) {
      continue;
    }

    sessions.push(session);
    workflowStatuses[row.sessionId] = toPiWorkflowStatus(row.workflowStatus);
  }

  return { sessions, workflowStatuses };
}

export function resolvePiSessionListingState({
  snapshot,
  synchronized,
  error,
}: {
  snapshot: PiSessionListingSnapshot;
  synchronized: boolean;
  error: string | null;
}): PiSessionListingState {
  if (error) {
    return { status: "error", snapshot, error };
  }

  return synchronized ? { status: "ready", snapshot } : { status: "synchronizing", snapshot };
}
