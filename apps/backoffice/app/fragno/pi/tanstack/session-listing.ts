import type { PiSession, PiWorkflowStatus } from "@fragno-dev/pi-harness/types";

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
  name: string | null;
  agent: string;
  workflowName: string;
  createdAt: Date;
  updatedAt: Date;
  workflowStatus: string | null | undefined;
};

export type PiSessionListingSnapshot = {
  sessions: PiSession[];
  workflowStatuses: Record<string, PiWorkflowStatus | null>;
};

export type PiSessionListingState =
  | { status: "synchronizing"; snapshot: PiSessionListingSnapshot }
  | { status: "ready"; snapshot: PiSessionListingSnapshot }
  | { status: "error"; snapshot: PiSessionListingSnapshot; error: string };

const toPiWorkflowStatus = (status: string | null | undefined): PiWorkflowStatus | null =>
  status && PI_WORKFLOW_STATUSES.has(status) ? (status as PiWorkflowStatus) : null;

export function buildPiSessionListingQuery(
  query: InitialQueryBuilder,
  {
    collections,
    workflowName,
    limit,
  }: {
    collections: Pick<PiCollections, "sessions" | "workflowInstances">;
    workflowName: string;
    limit: number;
  },
) {
  return query
    .from({ session: collections.sessions })
    .leftJoin({ workflow: collections.workflowInstances }, ({ session, workflow }) =>
      eq(session.id, workflow.id),
    )
    .where(({ session }) => eq(session.workflowName, workflowName))
    .orderBy(({ session }) => session.createdAt, "desc")
    .orderBy(({ session }) => session.id, "desc")
    .limit(limit)
    .select(({ session, workflow }) => ({
      sessionId: session.sessionId,
      name: session.name,
      agent: session.agent,
      workflowName: session.workflowName,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      workflowStatus: workflow?.status,
    }));
}

export function projectPiSessionListingRows(
  rows: readonly PiSessionListingRow[],
): PiSessionListingSnapshot {
  const sessions = rows.map(
    (row): PiSession => ({
      id: row.sessionId,
      name: row.name,
      agent: row.agent,
      workflowName: row.workflowName,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  );
  const workflowStatuses: Record<string, PiWorkflowStatus | null> = {};
  for (const row of rows) {
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
