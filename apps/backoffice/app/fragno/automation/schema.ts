import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const automationFragmentSchema = schema("automations", (s) => {
  return s
    .addTable("kv_store", (t) => {
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
    })
    .addTable("project", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("slug", column("string"))
        .addColumn("name", column("string"))
        .addColumn("description", column("text").nullable())
        .addColumn("archivedAt", column("timestamp").nullable())
        .addColumn("createdByUserId", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_project_slug", ["slug"], { unique: true });
    });
});
