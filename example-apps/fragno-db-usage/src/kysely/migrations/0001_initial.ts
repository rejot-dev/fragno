import { Kysely, sql } from "kysely";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("user")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("email", "varchar", (col) => col.notNull().unique())
    .addColumn("name", "varchar", (col) => col.notNull())
    .addColumn("created_at", "timestamp", (col) => col.defaultTo(sql`now()`).notNull())
    .execute();

  await db.schema
    .createTable("blog_post")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("title", "varchar", (col) => col.notNull())
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("author_id", "integer", (col) =>
      col.references("user.id").onDelete("cascade").notNull(),
    )
    .addColumn("created_at", "timestamp", (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn("updated_at", "timestamp", (col) => col.defaultTo(sql`now()`).notNull())
    .execute();

  await db.schema
    .createIndex("blog_post_author_id_index")
    .on("blog_post")
    .column("author_id")
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("blog_post").execute();
  await db.schema.dropTable("user").execute();
}
