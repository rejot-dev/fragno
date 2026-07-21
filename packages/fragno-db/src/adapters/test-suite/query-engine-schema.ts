import { column, idColumn, referenceColumn, schema } from "../../schema/create";

export const queryEngineSuiteSchema = schema("query_engine_suite", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .addColumn("age", column("integer").nullable())
        .createIndex("users_name_idx", ["name"])
        .createIndex("users_email_idx", ["email"], { unique: true })
        .createIndex("users_name_id_idx", ["name", "id"])
        .createIndex("users_age_idx", ["age"]),
    )
    .addTable("emails", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("user_id", referenceColumn({ table: "users" }))
        .addColumn("email", column("string"))
        .addColumn("is_primary", column("bool").defaultTo(false))
        .addColumn(
          "runtime_label",
          column("string").defaultTo$(() => "runtime-generated"),
        )
        .createIndex("emails_email_idx", ["email"], { unique: true })
        .createIndex("emails_user_idx", ["user_id"]),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("user_id", referenceColumn({ table: "users" }).nullable())
        .addColumn("title", column("string"))
        .addColumn("content", column("text"))
        .addColumn(
          "created_at",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("posts_user_idx", ["user_id"])
        .createIndex("posts_title_idx", ["title"]),
    )
    .addTable("comments", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("post_id", referenceColumn({ table: "posts" }))
        .addColumn("user_id", referenceColumn({ table: "users" }))
        .addColumn("text", column("text"))
        .createIndex("comments_post_idx", ["post_id"])
        .createIndex("comments_user_idx", ["user_id"]),
    )
    .addTable("tags", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .createIndex("tags_name_idx", ["name"], { unique: true }),
    )
    .addTable("post_tags", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("post_id", referenceColumn({ table: "posts" }))
        .addColumn("tag_id", referenceColumn({ table: "tags" }))
        .createIndex("post_tags_post_idx", ["post_id"])
        .createIndex("post_tags_tag_idx", ["tag_id"]),
    )
    .addTable("events", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn(
          "created_at",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("happened_on", column("date"))
        .addColumn("payload", column("json"))
        .addColumn("big_score", column("bigint"))
        .createIndex("events_name_idx", ["name"]),
    )
    .addTable("memberships", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("user_id", referenceColumn({ table: "users" }))
        .createIndex("memberships_user_idx", ["user_id"]),
    )
    .addTable("invitations", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .createIndex("invitations_email_idx", ["email"]),
    ),
);

export const queryEngineSuiteSecondarySchema = schema("query_engine_suite_secondary", (s) =>
  s
    .addTable("products", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("price", column("integer"))
        .createIndex("products_name_idx", ["name"]),
    )
    .addTable("orders", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("product_id", referenceColumn({ table: "products" }))
        .addColumn("quantity", column("integer"))
        .addColumn("user_id", column("string"))
        .createIndex("orders_user_idx", ["user_id"])
        .createIndex("orders_product_idx", ["product_id"]),
    ),
);
