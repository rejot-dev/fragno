import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const upvoteSchema = schema("upvote", (s) => {
  return s
    .addTable("upvote", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("reference", column("string"))
        .addColumn("ownerReference", column("string").nullable())
        .addColumn("rating", column("integer"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("note", column("string").nullable())
        .createIndex("idx_upvote_reference", ["reference", "ownerReference"]);
    })
    .addTable("upvote_total", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("reference", column("string"))
        .addColumn("total", column("integer").defaultTo(0))
        .createIndex("idx_upvote_total_reference", ["reference"], { unique: true });
    });
});
