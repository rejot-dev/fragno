import type { PiSession, PiWorkflowStatus } from "@fragno-dev/pi-harness/types";

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
