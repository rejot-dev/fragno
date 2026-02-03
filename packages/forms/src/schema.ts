import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const formsSchema = schema("forms", (s) => {
  return s
    .addTable("form", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("description", column("string").nullable())
        .addColumn("slug", column("string"))
        .addColumn(
          "status",
          column("string").defaultTo(() => "draft"),
        )
        .addColumn("dataSchema", column("json"))
        .addColumn("uiSchema", column("json").nullable())
        .addColumn(
          "version",
          column("integer").defaultTo(() => 1),
        )
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_form_status", ["status"])
        .createIndex("idx_form_slug", ["slug"], { unique: true });
    })
    .addTable("response", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("formId", column("string"))
        .addColumn("formVersion", column("integer"))
        .addColumn("data", column("json"))
        .addColumn(
          "submittedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("userAgent", column("string").nullable())
        .addColumn("ip", column("string").nullable())
        .createIndex("idx_response_form", ["formId"])
        .createIndex("idx_response_submitted_at", ["submittedAt"]);
    });
});
