import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const noteSchema = schema((s) => {
  return s
    .addTable("user", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .createIndex("idx_user_email", ["email"], { unique: true });
    })
    .addTable("note", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("content", column("string"))
        .addColumn("userId", referenceColumn())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_note_user", ["userId"]);
    })
    .addReference("author", {
      type: "one",
      from: { table: "note", column: "userId" },
      to: { table: "user", column: "id" },
    });
});
