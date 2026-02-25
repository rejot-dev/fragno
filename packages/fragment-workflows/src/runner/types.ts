// Shared types for runner helpers and transactions.

import type {
  TableToColumnValues,
  TableToInsertValues,
  TableToUpdateValues,
} from "@fragno-dev/db/query";
import type { workflowsSchema } from "../schema";

export type RunnerTaskKind = "run" | "wake" | "retry";

export type WorkflowInstanceRecord = TableToColumnValues<
  (typeof workflowsSchema)["tables"]["workflow_instance"]
>;

export type WorkflowInstanceUpdate = Partial<Omit<WorkflowInstanceRecord, "id">>;

export type WorkflowInstanceUpdateInput = WorkflowInstanceUpdate & {
  setStartedAtNow?: boolean;
  setCompletedAtNow?: boolean;
};

export type WorkflowStepRecord = TableToColumnValues<
  (typeof workflowsSchema)["tables"]["workflow_step"]
>;

export type WorkflowEventRecord = TableToColumnValues<
  (typeof workflowsSchema)["tables"]["workflow_event"]
>;

export type WorkflowStepCreate = Omit<
  TableToInsertValues<(typeof workflowsSchema)["tables"]["workflow_step"]>,
  "id" | "createdAt" | "updatedAt"
>;

export type WorkflowStepUpdate = Omit<
  TableToUpdateValues<(typeof workflowsSchema)["tables"]["workflow_step"]>,
  "createdAt" | "updatedAt"
>;

export type WorkflowEventUpdate = TableToUpdateValues<
  (typeof workflowsSchema)["tables"]["workflow_event"]
>;

export type WorkflowRunAt = Date | { delayMs: number };

export type WorkflowStepCreateDraft = WorkflowStepCreate & {
  nextRetryDelayMs?: number | null;
  wakeDelayMs?: number | null;
};

export type WorkflowStepUpdateDraft = WorkflowStepUpdate & {
  nextRetryDelayMs?: number | null;
  wakeDelayMs?: number | null;
};
