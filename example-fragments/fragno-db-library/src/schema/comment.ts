import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const commentSchema = schema("comment", (s) => {
  return s
    .addTable("comment", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("content", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("postReference", column("string")) // FIXME: Support external references
        .addColumn("userReference", column("string"))
        .addColumn("parentId", referenceColumn().nullable())
        .createIndex("idx_comment_post", ["postReference"]);
    })
    .addReference("parent", {
      type: "one",
      from: { table: "comment", column: "parentId" },
      to: { table: "comment", column: "id" },
    })
    .alterTable("comment", (t) => {
      return t.addColumn("rating", column("integer").defaultTo(0));
    });
});
