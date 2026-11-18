// Shared types for runner helpers and transactions.

import type {
  TableToColumnValues,
  TableToInsertValues,
  TableToUpdateValues,
} from "@fragno-dev/db/query";

import type { workflowsSchema } from "../schema";

/** What a tick does: run the workflow, or also resume the waits and retries due by its time. */
export type RunnerTask = { kind: "run" } | { kind: "wake" | "retry"; at: Date };

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

export type WorkflowStepEmissionRecord = TableToColumnValues<
  (typeof workflowsSchema)["tables"]["workflow_step_emission"]
>;

export type WorkflowStepCreate = Omit<
  TableToInsertValues<(typeof workflowsSchema)["tables"]["workflow_step"]>,
  "id" | "createdAt" | "updatedAt" | "committedByExecutionId"
>;

export type WorkflowStepUpdate = Omit<
  TableToUpdateValues<(typeof workflowsSchema)["tables"]["workflow_step"]>,
  "createdAt" | "updatedAt" | "committedByExecutionId"
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
