// Workflow instance state transitions with optimistic concurrency guards.

import { ConcurrencyConflictError } from "@fragno-dev/db";
import { FragnoId } from "@fragno-dev/db/schema";
import type { FragnoRuntime } from "@fragno-dev/core";
import { workflowsSchema } from "../schema";
import { isTerminalStatus } from "./status";
import type { RunHandlerTx, WorkflowInstanceRecord, WorkflowInstanceUpdate } from "./types";

type InstanceContext = {
  runHandlerTx: RunHandlerTx;
  time: FragnoRuntime["time"];
};

export const setInstanceStatus = async (
  instance: WorkflowInstanceRecord,
  status: string,
  update: Partial<WorkflowInstanceUpdate>,
  ctx: InstanceContext,
): Promise<boolean> => {
  const { id: _ignoredId, ...safeUpdate } = update as WorkflowInstanceRecord;

  try {
    const outcome = await ctx.runHandlerTx((handlerTx) =>
      handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(workflowsSchema).findFirst("workflow_instance", (b) =>
            b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
              eb.and(
                eb("workflowName", "=", instance.workflowName),
                eb("instanceId", "=", instance.instanceId),
              ),
            ),
          ),
        )
        .transformRetrieve(([current]) => {
          if (!current) {
            return { kind: "noop" as const };
          }

          if (current.runNumber !== instance.runNumber) {
            return { kind: "noop" as const };
          }

          if (isTerminalStatus(current.status)) {
            return { kind: "noop" as const };
          }

          return { kind: "update" as const, id: current.id };
        })
        .mutate(({ forSchema, retrieveResult }) => {
          if (retrieveResult.kind !== "update") {
            return;
          }
          const currentId = retrieveResult.id;
          forSchema(workflowsSchema).update("workflow_instance", currentId, (b) => {
            const builder = b.set({
              ...safeUpdate,
              status,
              updatedAt: ctx.time.now(),
            });
            if (currentId instanceof FragnoId) {
              builder.check();
            }
            return builder;
          });
        })
        .transform(({ retrieveResult }) => retrieveResult)
        .execute(),
    );
    return outcome.kind === "update";
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return false;
    }
    throw err;
  }
};
