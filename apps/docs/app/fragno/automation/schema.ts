import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const automationFragmentSchema = schema("automations", (s) => {
  return s
    .addTable("script", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("key", column("string"))
        .addColumn("name", column("string"))
        .addColumn("engine", column("string").defaultTo("bash"))
        .addColumn("script", column("string"))
        .addColumn("version", column("integer").defaultTo(1))
        .addColumn("enabled", column("bool").defaultTo(true))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_script_key", ["key", "version"], {
          unique: true,
        });
    })
    .addTable("trigger_binding", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("eventType", column("string"))
        .addColumn("source", column("string"))
        .addColumn("scriptId", referenceColumn())
        .addColumn("enabled", column("bool").defaultTo(true))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_trigger_binding_event", ["eventType"])
        .createIndex("idx_trigger_binding_source_event_created_at_id", [
          "source",
          "eventType",
          "createdAt",
          "id",
        ]);
    })
    .addTable("identity_binding", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("source", column("string"))
        .addColumn("externalActorId", column("string"))
        .addColumn("userId", column("string"))
        .addColumn("status", column("string").defaultTo("linked"))
        .addColumn(
          "linkedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_identity_binding_source_actor", ["source", "externalActorId"], {
          unique: true,
        })
        .createIndex("idx_identity_binding_user", ["userId"]);
    })
    .addReference("triggerBindingScript", {
      type: "one",
      from: { table: "trigger_binding", column: "scriptId" },
      to: { table: "script", column: "id" },
    });
});
