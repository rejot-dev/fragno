import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const piSchema = schema("pi-fragment", (s) => {
  return s.addTable("session", (t) => {
    return (
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string").nullable())
        .addColumn("agent", column("string"))
        // Possible statuses: active, paused, errored, terminated, complete, waiting.
        .addColumn("status", column("string"))
        .addColumn("workflowInstanceId", column("string").nullable())
        .addColumn("steeringMode", column("string"))
        .addColumn("metadata", column("json").nullable())
        .addColumn("tags", column("json").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_session_status", ["status"])
        .createIndex("idx_session_created", ["createdAt"])
    );
  });
});
