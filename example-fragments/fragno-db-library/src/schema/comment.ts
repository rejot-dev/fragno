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
        .addColumn("parentId", referenceColumn({ table: "comment" }).nullable())
        .createIndex("idx_comment_post", ["postReference"]);
    })
    .noOp("removed obsolete comment.parent addReference history")
    .alterTable("comment", (t) => {
      return t.addColumn("rating", column("integer").defaultTo(0));
    });
});
