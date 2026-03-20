import { column, idColumn, schema } from "@fragno-dev/db/schema";

/** Default `triggerOrder`: sorts after any explicit lower values. */
export const AUTOMATION_TRIGGER_ORDER_LAST = 2_147_483_647;

export const automationFragmentSchema = schema("automations", (s) => {
  return s.addTable("identity_binding", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("source", column("string"))
      .addColumn("key", column("string"))
      .addColumn("value", column("string"))
      .addColumn("description", column("string").nullable())
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
      .createIndex("idx_identity_binding_source_key", ["source", "key"], {
        unique: true,
      })
      .createIndex("idx_identity_binding_value", ["value"]);
  });
});
