import { column, idColumn, schema } from "@fragno-dev/db/schema";

/** Default `triggerOrder`: sorts after any explicit lower values. */

export const automationFragmentSchema = schema("automations", (s) => {
  return s.addTable("kv_store", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("key", column("string"))
      .addColumn("value", column("string"))
      .addColumn("description", column("string").nullable())
      .addColumn("category", column("json").nullable())
      .addColumn("actor", column("json").nullable())
      .addColumn(
        "createdAt",
        column("timestamp").defaultTo((b) => b.now()),
      )
      .addColumn(
        "updatedAt",
        column("timestamp").defaultTo((b) => b.now()),
      )
      .createIndex("idx_kv_store_key", ["key"], {
        unique: true,
      });
  });
});
