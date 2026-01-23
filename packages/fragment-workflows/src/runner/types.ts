// Shared types for runner helpers and transactions.

import type { FragnoRuntime } from "@fragno-dev/core";
import type { TableToColumnValues } from "@fragno-dev/db/query";
import type { workflowsSchema } from "../schema";
import type { WorkflowsRegistry, WorkflowsRunner } from "../workflow";
import type { DatabaseRequestContext } from "@fragno-dev/db";

export type WorkflowTaskRecord = TableToColumnValues<
  (typeof workflowsSchema)["tables"]["workflow_task"]
>;

export type WorkflowInstanceRecord = TableToColumnValues<
  (typeof workflowsSchema)["tables"]["workflow_instance"]
>;

export type WorkflowInstanceUpdate = Omit<WorkflowInstanceRecord, "id">;

export type WorkflowStepRecord = TableToColumnValues<
  (typeof workflowsSchema)["tables"]["workflow_step"]
>;

export type WorkflowsRunnerFragment = {
  inContext: <T>(callback: (this: DatabaseRequestContext) => T | Promise<T>) => T | Promise<T>;
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
  callback: (handlerTx: DatabaseRequestContext["handlerTx"]) => T | Promise<T>,
) => Promise<T>;

export type RunnerFactory = (options: WorkflowsRunnerOptions) => WorkflowsRunner;
