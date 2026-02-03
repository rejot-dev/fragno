import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const authSchema = schema((s) => {
  return s
    .addTable("user", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("passwordHash", column("string"))
        .addColumn("role", column("string").defaultTo("user"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_user_email", ["email"])
        .createIndex("idx_user_id", ["id"], { unique: true });
    })
    .addTable("session", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("userId", referenceColumn())
        .addColumn("expiresAt", column("timestamp"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_session_user", ["userId"]);
    })
    .addReference("sessionOwner", {
      from: {
        table: "session",
        column: "userId",
      },
      to: {
        table: "user",
        column: "id",
      },
      type: "one",
    })
    .alterTable("user", (t) => {
      return t.createIndex("idx_user_createdAt", ["createdAt"]);
    });
});
