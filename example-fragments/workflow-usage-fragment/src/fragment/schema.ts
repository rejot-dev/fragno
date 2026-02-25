import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const workflowUsageSchema = schema("workflow-usage-fragment", (s) => {
  return s
    .addTable("session", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string").nullable())
        .addColumn("agent", column("string"))
        .addColumn("status", column("string"))
        .addColumn("workflowInstanceId", column("string").nullable())
        .addColumn("metadata", column("json").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_session_status", ["status"])
        .createIndex("idx_session_created", ["createdAt"]);
    })
    .addTable("step", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("sessionId", column("string"))
        .addColumn("turn", column("integer"))
        .addColumn("index", column("integer"))
        .addColumn("type", column("string"))
        .addColumn("name", column("string"))
        .addColumn("result", column("json").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_step_session", ["sessionId"])
        .createIndex("idx_step_session_turn", ["sessionId", "turn"]);
    });
});
