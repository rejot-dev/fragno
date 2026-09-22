import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const sandboxManagerFragmentSchema = schema("sandbox-manager", (s) =>
  s.addTable("sandbox_instance", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("provider", column("string"))
      .addColumn("status", column("string"))
      .addColumn("workflowInstanceId", column("string").nullable())
      .addColumn("keepAlive", column("bool"))
      .addColumn("sleepAfter", column("json").nullable())
      .addColumn("startupCommand", column("text"))
      .addColumn("startupTimeoutMs", column("integer").nullable())
      .addColumn("startedAt", column("timestamp").nullable())
      .addColumn("expectedStopAt", column("timestamp").nullable())
      .addColumn("stoppedAt", column("timestamp").nullable())
      .addColumn("lastError", column("text").nullable())
      .addColumn(
        "createdAt",
        column("timestamp").defaultTo((b) => b.now()),
      )
      .addColumn(
        "updatedAt",
        column("timestamp").defaultTo((b) => b.now()),
      )
      .createIndex("idx_sandbox_instance_provider", ["provider"])
      .createIndex("idx_sandbox_instance_status", ["status"])
      .createIndex("idx_sandbox_instance_workflowInstanceId", ["workflowInstanceId"]),
  ),
);
