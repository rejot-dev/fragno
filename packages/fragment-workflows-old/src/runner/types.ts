// Shared types for runner helpers and transactions.

import type { FragnoRuntime } from "@fragno-dev/core";
import type { TableToColumnValues } from "@fragno-dev/db/query";
import type { workflowsSchema } from "../schema";
import type { WorkflowsHooks, WorkflowsRegistry, WorkflowsRunner } from "../workflow";
import type { DatabaseRequestContext } from "@fragno-dev/db";

export type WorkflowTaskRecord = TableToColumnValues<
  (typeof workflowsSchema)["tables"]["workflow_task"]
>;

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

export type WorkflowLogRecord = TableToColumnValues<
  (typeof workflowsSchema)["tables"]["workflow_log"]
>;

export type WorkflowStepCreate = Omit<WorkflowStepRecord, "id" | "createdAt" | "updatedAt">;

export type WorkflowLogCreate = Omit<WorkflowLogRecord, "id" | "createdAt">;

export type WorkflowStepUpdate = Omit<
  Partial<Omit<WorkflowStepRecord, "id">>,
  "createdAt" | "updatedAt"
>;

export type WorkflowEventUpdate = Partial<Omit<WorkflowEventRecord, "id">>;

export type WorkflowRunAt = Date | { delayMs: number };

export type WorkflowStepCreateDraft = WorkflowStepCreate & {
  nextRetryDelayMs?: number | null;
  wakeDelayMs?: number | null;
};

export type WorkflowStepUpdateDraft = WorkflowStepUpdate & {
  nextRetryDelayMs?: number | null;
  wakeDelayMs?: number | null;
};

export type WorkflowsRunnerFragment = {
  inContext: <T>(
    callback: (this: DatabaseRequestContext<WorkflowsHooks>) => T | Promise<T>,
  ) => T | Promise<T>;
  services: Record<string, unknown>;
};

export type WorkflowsRunnerOptions = {
  fragment: WorkflowsRunnerFragment;
  workflows: WorkflowsRegistry;
  runtime: FragnoRuntime;
  runnerId?: string;
  leaseMs?: number;
};

export type RunHandlerTx = <T>(
  callback: (handlerTx: DatabaseRequestContext<WorkflowsHooks>["handlerTx"]) => T | Promise<T>,
) => Promise<T>;

export type RunnerFactory = (options: WorkflowsRunnerOptions) => WorkflowsRunner;
