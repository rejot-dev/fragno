import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const noteSchema = schema((s) => {
  return s.addTable("note", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("content", column("string"))
      .addColumn("userId", column("string"))
      .addColumn(
        "createdAt",
        column("timestamp").defaultTo((b) => b.now()),
      )
      .createIndex("idx_note_user", ["userId"]);
  });
});
