// Database schema for workflow instances, steps, and events.

import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const workflowsSchema = schema("workflows", (s) => {
  return (
    s
      // Per-run instance lifecycle and metadata.
      .addTable("workflow_instance", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("instanceId", column("string"))
          .addColumn("workflowName", column("string"))
          .addColumn("status", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn(
            "updatedAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn("startedAt", column("timestamp").nullable())
          .addColumn("completedAt", column("timestamp").nullable())
          .addColumn("params", column("json"))
          .addColumn("output", column("json").nullable())
          .addColumn("errorName", column("string").nullable())
          .addColumn("errorMessage", column("string").nullable())
          .addColumn("pauseRequested", column("bool").defaultTo(false))
          .addColumn("runNumber", column("integer").defaultTo(0))
          .createIndex(
            "idx_workflow_instance_workflowName_instanceId",
            ["workflowName", "instanceId"],
            {
              unique: true,
            },
          )
          .createIndex("idx_workflow_instance_status_updatedAt", [
            "workflowName",
            "status",
            "updatedAt",
          ]);
      })
      // Durable step execution history and wait state.
      .addTable("workflow_step", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("instanceRef", referenceColumn())
          .addColumn("workflowName", column("string"))
          .addColumn("instanceId", column("string"))
          .addColumn("runNumber", column("integer"))
          .addColumn("stepKey", column("string"))
          .addColumn("name", column("string"))
          .addColumn("type", column("string"))
          .addColumn("status", column("string"))
          .addColumn("attempts", column("integer").defaultTo(0))
          .addColumn("maxAttempts", column("integer"))
          .addColumn("timeoutMs", column("integer").nullable())
          .addColumn("nextRetryAt", column("timestamp").nullable())
          .addColumn("wakeAt", column("timestamp").nullable())
          .addColumn("waitEventType", column("string").nullable())
          .addColumn("result", column("json").nullable())
          .addColumn("errorName", column("string").nullable())
          .addColumn("errorMessage", column("string").nullable())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn(
            "updatedAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex(
            "idx_workflow_step_workflowName_instanceId_runNumber_stepKey",
            ["workflowName", "instanceId", "runNumber", "stepKey"],
            { unique: true },
          )
          .createIndex("idx_workflow_step_instanceRef_runNumber", ["instanceRef", "runNumber"])
          .createIndex("idx_workflow_step_history_createdAt", [
            "workflowName",
            "instanceId",
            "runNumber",
            "createdAt",
          ])
          .createIndex("idx_workflow_step_status_wakeAt", [
            "workflowName",
            "instanceId",
            "runNumber",
            "status",
            "wakeAt",
          ])
          .createIndex("idx_workflow_step_workflowName_instanceId_status", [
            "workflowName",
            "instanceId",
            "status",
          ])
          .createIndex("idx_workflow_step_status_nextRetryAt", ["status", "nextRetryAt"]);
      })
      // External events delivered to waiting workflows.
      .addTable("workflow_event", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("instanceRef", referenceColumn())
          .addColumn("workflowName", column("string"))
          .addColumn("instanceId", column("string"))
          .addColumn("runNumber", column("integer"))
          .addColumn("type", column("string"))
          .addColumn("payload", column("json").nullable())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn("deliveredAt", column("timestamp").nullable())
          .addColumn("consumedByStepKey", column("string").nullable())
          .createIndex("idx_workflow_event_type_deliveredAt", [
            "workflowName",
            "instanceId",
            "runNumber",
            "type",
            "deliveredAt",
          ])
          .createIndex("idx_workflow_event_instanceRef_runNumber_createdAt", [
            "instanceRef",
            "runNumber",
            "createdAt",
          ])
          .createIndex("idx_workflow_event_history_createdAt", [
            "workflowName",
            "instanceId",
            "runNumber",
            "createdAt",
          ]);
      })
      .addReference("stepInstance", {
        type: "one",
        from: { table: "workflow_step", column: "instanceRef" },
        to: { table: "workflow_instance", column: "id" },
      })
      .addReference("eventInstance", {
        type: "one",
        from: { table: "workflow_event", column: "instanceRef" },
        to: { table: "workflow_instance", column: "id" },
      })
  );
});
