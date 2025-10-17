import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { generateSchema } from "./generate";

describe("generateSchema", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable())
          .createIndex("idx_email", ["email"], { unique: true })
          .createIndex("idx_name", ["name"]);
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("content", column("string"))
          .addColumn("userId", referenceColumn())
          .addColumn("viewCount", column("integer").defaultTo(0))
          .createIndex("idx_user", ["userId"])
          .createIndex("idx_title", ["title"]);
      })
      .addReference("author", {
        type: "one",
        from: { table: "posts", column: "userId" },
        to: { table: "users", column: "id" },
      });
  });

  describe("postgresql", () => {
    it("should generate PostgreSQL schema", () => {
      const generated = generateSchema(testSchema, "postgresql");
      expect(generated).toMatchInlineSnapshot(`
        "import { pgTable, varchar, text, integer, bigserial, uniqueIndex, index, bigint, foreignKey } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const users = pgTable("users", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          email: text("email").notNull(),
          age: integer("age"),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          uniqueIndex("idx_email").on(table.email),
          index("idx_name").on(table.name)
        ])

        export const posts = pgTable("posts", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          title: text("title").notNull(),
          content: text("content").notNull(),
          userId: bigint("userId", { mode: "number" }).notNull(),
          viewCount: integer("viewCount").notNull().default(0),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users._internalId],
            name: "posts_users_author_fk"
          }),
          index("idx_user").on(table.userId),
          index("idx_title").on(table.title)
        ])

        export const postsRelations = relations(posts, ({ one, many }) => ({
          author: one(users, {
            relationName: "posts_users",
            fields: [posts.userId],
            references: [users._internalId]
          })
        }));"
      `);
    });
  });

  describe("mysql", () => {
    it("should generate MySQL schema", () => {
      const generated = generateSchema(testSchema, "mysql");
      expect(generated).toMatchInlineSnapshot(`
        "import { mysqlTable, varchar, text, integer, bigint, uniqueIndex, index, foreignKey } from "drizzle-orm/mysql-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const users = mysqlTable("users", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          email: text("email").notNull(),
          age: integer("age"),
          _internalId: bigint("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          uniqueIndex("idx_email").on(table.email),
          index("idx_name").on(table.name)
        ])

        export const posts = mysqlTable("posts", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          title: text("title").notNull(),
          content: text("content").notNull(),
          userId: bigint("userId").notNull(),
          viewCount: integer("viewCount").notNull().default(0),
          _internalId: bigint("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users._internalId],
            name: "posts_users_author_fk"
          }),
          index("idx_user").on(table.userId),
          index("idx_title").on(table.title)
        ])

        export const postsRelations = relations(posts, ({ one, many }) => ({
          author: one(users, {
            relationName: "posts_users",
            fields: [posts.userId],
            references: [users._internalId]
          })
        }));"
      `);
    });
  });

  describe("sqlite", () => {
    it("should generate SQLite schema", () => {
      const generated = generateSchema(testSchema, "sqlite");
      expect(generated).toMatchInlineSnapshot(`
        "import { sqliteTable, text, integer, uniqueIndex, index, blob, foreignKey } from "drizzle-orm/sqlite-core"
        import { createId } from "@fragno-dev/db/id"
        import { relations } from "drizzle-orm"

        export const users = sqliteTable("users", {
          id: text("id").notNull().$defaultFn(() => createId()),
          name: text("name").notNull(),
          email: text("email").notNull(),
          age: integer("age"),
          _internalId: integer("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          uniqueIndex("idx_email").on(table.email),
          index("idx_name").on(table.name)
        ])

        export const posts = sqliteTable("posts", {
          id: text("id").notNull().$defaultFn(() => createId()),
          title: text("title").notNull(),
          content: text("content").notNull(),
          userId: blob("userId", { mode: "bigint" }).notNull(),
          viewCount: integer("viewCount").notNull().default(0),
          _internalId: integer("_internalId").primaryKey().autoincrement().notNull(),
          _version: integer("_version").notNull().default(0)
        }, (table) => [
          foreignKey({
            columns: [table.userId],
            foreignColumns: [users._internalId],
            name: "posts_users_author_fk"
          }),
          index("idx_user").on(table.userId),
          index("idx_title").on(table.title)
        ])

        export const postsRelations = relations(posts, ({ one, many }) => ({
          author: one(users, {
            relationName: "posts_users",
            fields: [posts.userId],
            references: [users._internalId]
          })
        }));"
      `);
    });
  });

  describe("default values", () => {
    it("should handle runtime default values", () => {
      const timestampSchema = schema((s) => {
        return s.addTable("events", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("createdAt", column("timestamp").defaultTo$("now"));
        });
      });

      const generated = generateSchema(timestampSchema, "postgresql");
      expect(generated).toMatchInlineSnapshot(`
        "import { pgTable, varchar, timestamp, bigserial, integer } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"

        export const events = pgTable("events", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          createdAt: timestamp("createdAt").notNull().defaultNow(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })"
      `);
    });
  });

  describe("binary columns", () => {
    it("should generate custom type for binary columns", () => {
      const binarySchema = schema((s) => {
        return s.addTable("files", (t) => {
          return t.addColumn("id", idColumn()).addColumn("data", column("binary"));
        });
      });

      const generated = generateSchema(binarySchema, "postgresql");
      expect(generated).toMatchInlineSnapshot(`
        "import { pgTable, varchar, customType, bigserial, integer } from "drizzle-orm/pg-core"
        import { createId } from "@fragno-dev/db/id"

        const customBinary = customType<
          {
            data: Uint8Array;
            driverData: Buffer;
          }
        >({
          dataType() {
            return "bytea";
          },
          fromDriver(value) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          },
          toDriver(value) {
            return value instanceof Buffer? value : Buffer.from(value)
          }
        });

        export const files = pgTable("files", {
          id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
          data: customBinary("data").notNull(),
          _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
          _version: integer("_version").notNull().default(0)
        })"
      `);
    });
  });
});
