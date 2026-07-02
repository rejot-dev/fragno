import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const piSchema = schema("pi-harness", (s) => {
  return s.addTable("session", (t) => {
    return (
      t
        // id is the scoped persistence row id; sessionId is the workflow instance id exposed to callers.
        .addColumn("id", idColumn())
        .addColumn("sessionId", column("string"))
        .addColumn("name", column("string").nullable())
        .addColumn("agent", column("string"))
        .addColumn("workflowName", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_session_created", ["createdAt"])
        .createIndex("idx_session_workflow_created", ["workflowName", "createdAt"])
        .createIndex("idx_session_workflow_session", ["workflowName", "sessionId"], {
          unique: true,
        })
    );
  });
});
