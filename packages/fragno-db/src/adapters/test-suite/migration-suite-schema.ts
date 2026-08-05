import { column, idColumn, referenceColumn, schema } from "../../schema/create";

export const migrationSuiteSchema = schema("migration_suite", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("name", column("string"))
        .createIndex("users_email_idx", ["email"], { unique: true }),
    )
    .alterTable("users", (t) =>
      t.addColumn("age", column("integer").nullable()).createIndex("users_age_idx", ["age"]),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .addColumn("title", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("posts_author_idx", ["authorId"]),
    )
    .alterTable("users", (t) => t.alterColumn("name").nullable()),
);
